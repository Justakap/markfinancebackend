const assert = require("assert");

// A fake (non-.gz) instrument-master URL so loadInstruments() takes the
// plain-JSON branch (no gunzip needed) — set before requiring the service
// so its module-level INSTRUMENT_MASTER_URL constant picks it up.
process.env.UPSTOX_INSTRUMENT_MASTER_URL = "https://fake.test/instruments.json";

const axios = require("axios");

const FAKE_INSTRUMENTS = [
    {
        instrument_key: "NSE_EQ|TEST0001",
        trading_symbol: "TESTSTOCK",
        name: "Test Stock Ltd",
        exchange: "NSE",
        instrument_type: "EQ",
        segment: "NSE_EQ",
    },
];

let downloadCount = 0;
let behavior = "succeed"; // "succeed" | "fail" | "succeed-after-delay"
let delayMs = 20;

const originalAxiosGet = axios.get.bind(axios);
axios.get = (url, config) => {
    if (url !== process.env.UPSTOX_INSTRUMENT_MASTER_URL) {
        return originalAxiosGet(url, config);
    }

    downloadCount += 1;

    return new Promise((resolve, reject) => {
        setTimeout(() => {
            if (behavior === "fail") {
                const error = new Error("simulated instrument master download failure");
                error.request = {};
                reject(error);
                return;
            }

            resolve({
                data: Buffer.from(JSON.stringify(FAKE_INSTRUMENTS), "utf8"),
            });
        }, delayMs);
    });
};

// Re-require after mocking axios.get and setting the env var so the module
// picks up the fake URL and the mocked network call.
delete require.cache[require.resolve("../services/marketDataService")];
const { loadInstruments, getInstrumentMeta, isValidInstrumentKey } = require("../services/marketDataService");

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

(async () => {
    console.log("Instrument master loading — in-flight deduplication\n");

    await test("1. a single caller triggers exactly one download", async () => {
        downloadCount = 0;
        behavior = "succeed";
        const result = await loadInstruments(true);
        assert.strictEqual(downloadCount, 1);
        assert.ok(Array.isArray(result) && result.length === 1);
    });

    await test("2. 5+ simultaneous callers trigger exactly one download", async () => {
        downloadCount = 0;
        behavior = "succeed";
        delayMs = 30;

        const callers = Array.from({ length: 8 }, () => loadInstruments(true));
        await Promise.all(callers);

        assert.strictEqual(downloadCount, 1, "8 concurrent forced calls should share one in-flight download");
    });

    await test("3. all simultaneous callers receive the same successful result", async () => {
        downloadCount = 0;
        behavior = "succeed";
        delayMs = 20;

        const results = await Promise.all(
            Array.from({ length: 5 }, () => loadInstruments(true)),
        );

        results.forEach((r) => assert.strictEqual(r, results[0], "every caller should get the identical array reference"));
        assert.strictEqual(downloadCount, 1);
    });

    await test("4. a failed download rejects every current caller", async () => {
        downloadCount = 0;
        behavior = "fail";
        delayMs = 20;

        const callers = Array.from({ length: 4 }, () => loadInstruments(true));
        const outcomes = await Promise.allSettled(callers);

        assert.strictEqual(downloadCount, 1, "concurrent callers should share one failing download, not retry individually");
        outcomes.forEach((o) => assert.strictEqual(o.status, "rejected"));
    });

    await test("5. after a failure, a later caller can retry successfully (no permanently-dead promise)", async () => {
        downloadCount = 0;
        behavior = "fail";
        delayMs = 10;

        await assert.rejects(loadInstruments(true));

        behavior = "succeed";
        const result = await loadInstruments(true);

        assert.strictEqual(downloadCount, 2, "the failed attempt plus one successful retry");
        assert.ok(Array.isArray(result) && result.length === 1);
    });

    await test("6. a warm (TTL-valid) cache serves from cache with zero new downloads", async () => {
        downloadCount = 0;
        behavior = "succeed";

        // Prime the cache (force=true ensures a real fetch happens here).
        await loadInstruments(true);
        downloadCount = 0;

        // Non-forced calls within the TTL window should hit the cache only.
        const results = await Promise.all([loadInstruments(), loadInstruments(), loadInstruments()]);

        assert.strictEqual(downloadCount, 0, "warm cache should serve without any network call");
        results.forEach((r) => assert.strictEqual(r, results[0]));
    });

    await test("7. instrument metadata is populated as before (existing behavior intact)", async () => {
        downloadCount = 0;
        behavior = "succeed";

        await loadInstruments(true);

        assert.ok(isValidInstrumentKey("NSE_EQ|TEST0001"));
        const meta = getInstrumentMeta("NSE_EQ|TEST0001");
        assert.strictEqual(meta.symbol, "TESTSTOCK");
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
