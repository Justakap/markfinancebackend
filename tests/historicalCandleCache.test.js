const assert = require("assert");

// Fake (non-.gz) instrument-master URL so marketDataService's loadInstruments()
// (reached indirectly via candleService -> instrumentKeyResolver.canFetchCandles)
// takes the plain-JSON branch against our mock, same pattern as
// instrumentMasterDedup.test.js.
process.env.UPSTOX_INSTRUMENT_MASTER_URL = "https://fake.test/instruments.json";
process.env.UPSTOX_ACCESS_TOKEN = "fake-token-for-tests";
process.env.UPSTOX_REQUEST_GAP_MS = "0";
process.env.UPSTOX_MAX_RETRIES = "1";
process.env.UPSTOX_RETRY_BASE_MS = "5";
process.env.UPSTOX_RETRY_MAX_MS = "10";

const axios = require("axios");

const TEST_KEY = "NSE_EQ|TEST0001";
const TEST_KEY_2 = "NSE_EQ|TEST0002";

const FAKE_INSTRUMENTS = [
    { instrument_key: TEST_KEY, trading_symbol: "TESTSTOCK", exchange: "NSE", instrument_type: "EQ", segment: "NSE_EQ" },
    { instrument_key: TEST_KEY_2, trading_symbol: "TESTSTOCK2", exchange: "NSE", instrument_type: "EQ", segment: "NSE_EQ" },
];

let rangeCallCount = 0;
let intradayCallCount = 0;
let rangeShouldFail = false;

function fakeCandles(seed) {
    // One candle is enough shape-wise for these tests (count-focused, not
    // indicator-math-focused).
    return [[`2026-10-0${seed}T09:15:00+05:30`, 100, 101, 99, 100.5, 1000, 0]];
}

const originalAxiosGet = axios.get.bind(axios);
axios.get = (url, config) => {
    if (url === process.env.UPSTOX_INSTRUMENT_MASTER_URL) {
        return Promise.resolve({ data: Buffer.from(JSON.stringify(FAKE_INSTRUMENTS), "utf8") });
    }

    if (url.includes("/historical-candle/intraday/")) {
        intradayCallCount += 1;
        return Promise.resolve({ data: { data: { candles: fakeCandles(7) } } });
    }

    if (url.includes("/historical-candle/")) {
        rangeCallCount += 1;
        if (rangeShouldFail) {
            // A permanent (non-retryable) failure shape, so this resolves in
            // one attempt instead of exercising the queue's retry/backoff.
            const error = new Error("simulated range endpoint failure");
            error.response = { status: 400, headers: {} };
            error.request = {};
            return Promise.reject(error);
        }
        return Promise.resolve({ data: { data: { candles: fakeCandles(1) } } });
    }

    return originalAxiosGet(url, config);
};

delete require.cache[require.resolve("../services/marketDataService")];
delete require.cache[require.resolve("../services/candleService")];
delete require.cache[require.resolve("../utils/instrumentKeyResolver")];
const { getCandles } = require("../services/candleService");

let passed = 0;
let failed = 0;

async function test(name, fn) {
    try {
        await fn();
        passed += 1;
        console.log(`  ✓ ${name}`);
    } catch (error) {
        failed += 1;
        console.error(`  ✗ ${name}`);
        console.error(`    ${error.message}`);
    }
}

function resetCounters() {
    rangeCallCount = 0;
    intradayCallCount = 0;
    rangeShouldFail = false;
}

(async () => {
    console.log("Historical minute-candle caching — through-yesterday range cache\n");

    await test("1. first fetch for an instrument/timeframe makes exactly one range call and one intraday call", async () => {
        resetCounters();
        const candles = await getCandles(TEST_KEY, { interval: "minutes", unit: "1", maxBars: 10 });
        assert.strictEqual(rangeCallCount, 1);
        assert.strictEqual(intradayCallCount, 1);
        assert.ok(Array.isArray(candles) && candles.length > 0);
    });

    await test("2. a second fetch shortly after (simulating a 15-30s refresh) reuses the cached historical range, but still fetches fresh intraday", async () => {
        resetCounters();
        await getCandles(TEST_KEY, { interval: "minutes", unit: "1", maxBars: 10 });
        const afterFirst = { rangeCallCount, intradayCallCount };

        await getCandles(TEST_KEY, { interval: "minutes", unit: "1", maxBars: 10 });

        assert.strictEqual(rangeCallCount, afterFirst.rangeCallCount, "historical range should be served from cache, not refetched");
        assert.strictEqual(intradayCallCount, afterFirst.intradayCallCount + 1, "today's intraday data must always be fetched fresh");
    });

    await test("3. concurrent simultaneous fetches for the same instrument/timeframe share one in-flight historical-range call", async () => {
        resetCounters();
        const calls = Array.from({ length: 6 }, () =>
            getCandles(TEST_KEY, { interval: "minutes", unit: "5", maxBars: 10 }),
        );
        await Promise.all(calls);

        assert.strictEqual(rangeCallCount, 1, "6 concurrent callers should collapse to one historical-range fetch");
    });

    await test("4. a different date range (different periodDays) is cached independently — new key, fresh fetch", async () => {
        resetCounters();
        await getCandles(TEST_KEY, { interval: "minutes", unit: "1", maxBars: 10, periodDays: 3 });
        const afterDefault = rangeCallCount;

        // A different periodDays changes fromDate, which is exactly the
        // mechanism that makes the cache key roll over at a day boundary —
        // this exercises that same key-differentiation path.
        await getCandles(TEST_KEY, { interval: "minutes", unit: "1", maxBars: 10, periodDays: 10 });

        assert.strictEqual(rangeCallCount, afterDefault + 1, "a distinct date range must not reuse another range's cache entry");
    });

    await test("5. a failed historical-range fetch is not cached — the next call retries the network", async () => {
        resetCounters();
        rangeShouldFail = true;

        // The historical-range call fails, but getCandles still resolves
        // (not throws) using intraday-only data — fetchHistoricalCandles
        // falls back to intraday when historical comes back empty. The
        // important assertion here is call counts, not the exact payload.
        const first = await getCandles(TEST_KEY, { interval: "minutes", unit: "15", maxBars: 10 });
        assert.strictEqual(rangeCallCount, 1);
        assert.ok(Array.isArray(first), "getCandles should not throw even when the historical range fetch fails");

        rangeShouldFail = false;
        const second = await getCandles(TEST_KEY, { interval: "minutes", unit: "15", maxBars: 10 });

        assert.strictEqual(rangeCallCount, 2, "a prior failure must not be cached — the next call should hit the network again");
        assert.ok(second.length > 0, "the retry should succeed now that the simulated failure is cleared");
    });

    await test("6. different instruments are cached independently (no cross-instrument contamination)", async () => {
        resetCounters();
        await getCandles(TEST_KEY, { interval: "minutes", unit: "1", maxBars: 10 });
        const afterFirstInstrument = rangeCallCount;

        await getCandles(TEST_KEY_2, { interval: "minutes", unit: "1", maxBars: 10 });

        assert.strictEqual(rangeCallCount, afterFirstInstrument + 1, "a different instrument must not reuse another instrument's cached range");
    });

    await test("7. hours/days timeframes are unaffected (out of this task's scope) — no caching applied there", async () => {
        resetCounters();
        await getCandles(TEST_KEY, { interval: "hours", unit: "1", maxBars: 10 });
        const afterFirst = rangeCallCount;

        await getCandles(TEST_KEY, { interval: "hours", unit: "1", maxBars: 10 });

        assert.strictEqual(rangeCallCount, afterFirst + 1, "hours timeframe should refetch every time, exactly as before this change");
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
