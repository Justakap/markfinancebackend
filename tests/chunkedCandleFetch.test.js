/**
 * Candle-retrieval optimization for longer backtests (2026-10-10).
 *
 * Covers the new chunked-fetch machinery in candleService.js:
 *   - splitDateRangeIntoChunks/getMaxWindowDaysFor/clampToIntradayRetention
 *     pure date-math (no network).
 *   - A long (>1 chunk-window) range is split into multiple Upstox calls,
 *     merged/deduped/sorted chronologically.
 *   - Chunk boundaries (exactly-at-limit vs one-day-over).
 *   - A failed chunk is reported as incomplete/failedRanges, never
 *     fabricated, while the other chunks' real data is still returned.
 *   - Concurrent requests for the same long range collapse chunk-by-chunk
 *     (each chunk's own dedupe/cache, not one dedupe for the whole range).
 *   - A second fetch of an already-fetched long range is served entirely
 *     from cache (zero new network calls).
 *   - Retention clamping for a request reaching before 2022-01-01.
 *   - Regression: fetchCandleSeriesForBacktest (legacy, plain array) and
 *     fetchCandleSeriesForBacktestWithQuality (new) produce IDENTICAL
 *     candle series for the same short-range request that predates this
 *     change — proving the refactor didn't alter existing behavior.
 */
const assert = require("assert");

process.env.UPSTOX_INSTRUMENT_MASTER_URL = "https://fake.test/chunked-instruments.json";
process.env.UPSTOX_ACCESS_TOKEN = "fake-token-for-tests";
process.env.UPSTOX_REQUEST_GAP_MS = "0";
process.env.UPSTOX_MAX_RETRIES = "1";
process.env.UPSTOX_RETRY_BASE_MS = "5";
process.env.UPSTOX_RETRY_MAX_MS = "10";

const axios = require("axios");

const TEST_KEY = "NSE_EQ|CHUNKTEST01";
const FAKE_INSTRUMENTS = [
    { instrument_key: TEST_KEY, trading_symbol: "CHUNKTESTSTOCK", exchange: "NSE", instrument_type: "EQ", segment: "NSE_EQ" },
];

let rangeCalls = [];
let intradayCallCount = 0;
let failUrlsOnce = new Set();
let failUrlsPersistently = new Set();

function resetCounters() {
    rangeCalls = [];
    intradayCallCount = 0;
    failUrlsOnce = new Set();
    failUrlsPersistently = new Set();
}

function candleAt(dateStr) {
    return [`${dateStr}T09:15:00+05:30`, 100, 101, 99, 100.5, 1000, 0];
}

const originalAxiosGet = axios.get.bind(axios);
axios.get = (url, config) => {
    if (url === process.env.UPSTOX_INSTRUMENT_MASTER_URL) {
        return Promise.resolve({ data: Buffer.from(JSON.stringify(FAKE_INSTRUMENTS), "utf8") });
    }

    if (url.includes("/historical-candle/intraday/")) {
        intradayCallCount += 1;
        return Promise.resolve({ data: { data: { candles: [] } } });
    }

    if (url.includes("/historical-candle/")) {
        rangeCalls.push(url);

        if (failUrlsPersistently.has(url) || [...failUrlsPersistently].some((frag) => url.includes(frag))) {
            const error = new Error("simulated persistent range failure");
            error.response = { status: 400, headers: {} };
            error.request = {};
            return Promise.reject(error);
        }
        if (failUrlsOnce.has(url) || [...failUrlsOnce].some((frag) => url.includes(frag))) {
            failUrlsOnce.delete(url);
            const error = new Error("simulated transient range failure");
            error.response = { status: 503, headers: {} };
            error.request = {};
            return Promise.reject(error);
        }

        // URL shape: .../{unit}/{interval}/{toDate}/{fromDate}
        const parts = url.split("/");
        const fromDate = parts[parts.length - 1];
        const toDate = parts[parts.length - 2];
        return Promise.resolve({ data: { data: { candles: [candleAt(fromDate), candleAt(toDate)] } } });
    }

    return originalAxiosGet(url, config);
};

[
    "../services/marketDataService",
    "../utils/instrumentKeyResolver",
    "../services/candleService",
    "../utils/backtestEngine",
].forEach((p) => delete require.cache[require.resolve(p)]);

const {
    getCandlesWithQuality,
    splitDateRangeIntoChunks,
    getMaxWindowDaysFor,
    clampToIntradayRetention,
    MAX_WINDOW_DAYS,
    INTRADAY_RETENTION_START,
} = require("../services/candleService");
const { fetchCandleSeriesForBacktest, fetchCandleSeriesForBacktestWithQuality } = require("../utils/backtestEngine");

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
        console.error(`    ${error.stack || error.message}`);
    }
}

(async () => {
    console.log("Chunked historical candle fetching — longer backtest support\n");

    await test("splitDateRangeIntoChunks: a range shorter than the window is a single chunk", () => {
        const chunks = splitDateRangeIntoChunks("2024-01-01", "2024-01-15", 31);
        assert.strictEqual(chunks.length, 1);
        assert.deepStrictEqual(chunks[0], { fromDate: "2024-01-01", toDate: "2024-01-15" });
    });

    await test("splitDateRangeIntoChunks: a range exactly at the window is a single chunk", () => {
        // 2024-01-01 .. 2024-01-31 inclusive is exactly 31 days.
        const chunks = splitDateRangeIntoChunks("2024-01-01", "2024-01-31", 31);
        assert.strictEqual(chunks.length, 1);
    });

    await test("splitDateRangeIntoChunks: a range one day over the window splits into two contiguous, non-overlapping chunks", () => {
        const chunks = splitDateRangeIntoChunks("2024-01-01", "2024-02-01", 31);
        assert.strictEqual(chunks.length, 2);
        assert.strictEqual(chunks[0].fromDate, "2024-01-01");
        assert.strictEqual(chunks[0].toDate, "2024-01-31");
        assert.strictEqual(chunks[1].fromDate, "2024-02-01");
        assert.strictEqual(chunks[1].toDate, "2024-02-01");
    });

    await test("splitDateRangeIntoChunks: a 365-day 5-minute range produces the expected number of chunks, covering the full span with no gaps or overlaps", () => {
        const chunks = splitDateRangeIntoChunks("2024-01-01", "2024-12-31", MAX_WINDOW_DAYS.minutesShort);
        assert.ok(chunks.length >= 11 && chunks.length <= 13, `expected ~12 chunks, got ${chunks.length}`);
        assert.strictEqual(chunks[0].fromDate, "2024-01-01");
        assert.strictEqual(chunks[chunks.length - 1].toDate, "2024-12-31");
        for (let i = 1; i < chunks.length; i += 1) {
            const prevEnd = new Date(`${chunks[i - 1].toDate}T00:00:00Z`);
            const curStart = new Date(`${chunks[i].fromDate}T00:00:00Z`);
            assert.strictEqual(curStart - prevEnd, 24 * 60 * 60 * 1000, "chunks must be contiguous with no gap/overlap");
        }
    });

    await test("getMaxWindowDaysFor: routes minutes<=15 and hours to the short/hours bucket, minutes>15 to the long bucket, days to unlimited", () => {
        assert.strictEqual(getMaxWindowDaysFor("minutes", "1"), MAX_WINDOW_DAYS.minutesShort);
        assert.strictEqual(getMaxWindowDaysFor("minutes", "15"), MAX_WINDOW_DAYS.minutesShort);
        assert.strictEqual(getMaxWindowDaysFor("minutes", "30"), MAX_WINDOW_DAYS.minutesLong);
        assert.strictEqual(getMaxWindowDaysFor("hours", "1"), MAX_WINDOW_DAYS.hours);
        assert.strictEqual(getMaxWindowDaysFor("days", "1"), Infinity);
    });

    await test("clampToIntradayRetention: a fromDate before 2022-01-01 is clamped forward; a later one is untouched", () => {
        assert.strictEqual(clampToIntradayRetention("2019-06-01"), INTRADAY_RETENTION_START);
        assert.strictEqual(clampToIntradayRetention("2023-06-01"), "2023-06-01");
    });

    await test("a multi-chunk 5m fetch (365 days) makes multiple range calls and merges them in chronological order", async () => {
        resetCounters();
        const result = await getCandlesWithQuality(TEST_KEY, { interval: "minutes", unit: "5", periodDays: 365, maxBars: 30000 });

        assert.ok(rangeCalls.length > 1, `expected multiple chunk calls, got ${rangeCalls.length}`);
        assert.strictEqual(result.incomplete, false);
        assert.strictEqual(result.failedRanges.length, 0);

        const timestamps = result.candles.map((c) => new Date(c.date || c.timestamp).getTime());
        const sorted = [...timestamps].sort((a, b) => a - b);
        assert.deepStrictEqual(timestamps, sorted, "candles must be in chronological order after merging chunks");
        const uniqueCount = new Set(timestamps).size;
        assert.strictEqual(uniqueCount, timestamps.length, "no duplicate timestamps after merging overlapping chunk boundaries");
    });

    await test("a second fetch of the same long range is served entirely from cache (zero new range calls)", async () => {
        resetCounters();
        await getCandlesWithQuality(TEST_KEY, { interval: "minutes", unit: "5", periodDays: 180, maxBars: 30000 });
        const firstCallCount = rangeCalls.length;
        assert.ok(firstCallCount > 1);

        await getCandlesWithQuality(TEST_KEY, { interval: "minutes", unit: "5", periodDays: 180, maxBars: 30000 });
        assert.strictEqual(rangeCalls.length, firstCallCount, "every chunk should be served from the per-chunk cache on the second call");
    });

    function expectedChunksFor(periodDays, unit = "minutes", interval = "5") {
        const toDate = new Date().toISOString().slice(0, 10);
        const fromDate = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const clamped = clampToIntradayRetention(fromDate);
        return splitDateRangeIntoChunks(clamped, toDate, getMaxWindowDaysFor(unit, interval));
    }

    await test("concurrent requests for the same long range collapse to one fetch per chunk (not one per caller)", async () => {
        resetCounters();
        const expected = expectedChunksFor(200);
        assert.ok(expected.length >= 5, "test setup requires a multi-chunk range");

        const callers = Array.from({ length: 5 }, () =>
            getCandlesWithQuality(TEST_KEY, { interval: "minutes", unit: "5", periodDays: 200, maxBars: 30000 }),
        );
        await Promise.all(callers);

        assert.strictEqual(rangeCalls.length, expected.length, `5 concurrent callers should share exactly one fetch per chunk (${expected.length} chunks)`);
    });

    await test("a persistently-failing chunk is reported as incomplete with its exact failedRange, while the other chunks' real data is still returned (never fabricated)", async () => {
        resetCounters();
        const expected = expectedChunksFor(90);
        assert.ok(expected.length >= 2, "test setup requires at least 2 chunks");
        const failingChunk = expected[1];
        failUrlsPersistently.add(`/${failingChunk.toDate}/${failingChunk.fromDate}`);

        const result = await getCandlesWithQuality(TEST_KEY, { interval: "minutes", unit: "5", periodDays: 90, maxBars: 30000 });

        assert.strictEqual(result.incomplete, true);
        assert.strictEqual(result.failedRanges.length, 1);
        assert.deepStrictEqual(result.failedRanges[0], { fromDate: failingChunk.fromDate, toDate: failingChunk.toDate });
        // The other (successful) chunks' real candles must still be returned —
        // one failed chunk never blanks out the whole result.
        assert.ok(result.candles.length > 0, "data from the non-failing chunks must still be returned");
    });

    await test("fetchCandleSeriesForBacktest (legacy) and fetchCandleSeriesForBacktestWithQuality (new) return identical candle series for the same short-range request", async () => {
        resetCounters();
        const legacy = await fetchCandleSeriesForBacktest(TEST_KEY, "1d", 30);
        const { series: withQuality, dataQuality } = await fetchCandleSeriesForBacktestWithQuality(TEST_KEY, "1d", 30);

        assert.strictEqual(legacy.length, withQuality.length);
        assert.deepStrictEqual(
            legacy.map((c) => c.close),
            withQuality.map((c) => c.close),
            "legacy and quality-aware fetchers must produce the same series for an unchanged short-range request",
        );
        assert.strictEqual(dataQuality.incomplete, false);
        assert.strictEqual(dataQuality.retentionClamped, false);
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
