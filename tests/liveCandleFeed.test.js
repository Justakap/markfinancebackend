/**
 * Workstream J — services/liveCandleFeed.js integration test. Mocks only
 * the axios/HTTP boundary (same technique as historicalCandleCache.test.js)
 * so the real candleService.getCandles -> dropFormingCandle ->
 * toBacktestQuote path is exercised end to end, proving the live engine's
 * candle source genuinely strips a still-forming trailing bar rather than
 * trusting the mock to already exclude one.
 */
const assert = require("assert");

process.env.UPSTOX_INSTRUMENT_MASTER_URL = "https://fake.test/live-candle-feed-instruments.json";
process.env.UPSTOX_ACCESS_TOKEN = "fake-token-for-tests";
process.env.UPSTOX_REQUEST_GAP_MS = "0";
process.env.UPSTOX_MAX_RETRIES = "1";
process.env.UPSTOX_RETRY_BASE_MS = "5";
process.env.UPSTOX_RETRY_MAX_MS = "10";

const axios = require("axios");

const TEST_KEY = "NSE_EQ|LIVECANDLE01";
const FAKE_INSTRUMENTS = [
    { instrument_key: TEST_KEY, trading_symbol: "LIVECANDLESTOCK", exchange: "NSE", instrument_type: "EQ", segment: "NSE_EQ" },
];

let nowIso = null;

const originalAxiosGet = axios.get.bind(axios);
axios.get = (url, config) => {
    if (url === process.env.UPSTOX_INSTRUMENT_MASTER_URL) {
        return Promise.resolve({ data: Buffer.from(JSON.stringify(FAKE_INSTRUMENTS), "utf8") });
    }
    if (url.includes("/historical-candle/intraday/")) {
        // Three 1-minute bars: 09:15, 09:16, 09:17 — "now" is set per-test
        // to control whether the last one is still forming.
        return Promise.resolve({
            data: {
                data: {
                    candles: [
                        ["2024-01-02T09:17:00+05:30", 103, 104, 102, 103.5, 50, 0],
                        ["2024-01-02T09:16:00+05:30", 102, 103, 101, 102.5, 40, 0],
                        ["2024-01-02T09:15:00+05:30", 100, 101, 99, 100.5, 30, 0],
                    ],
                },
            },
        });
    }
    if (url.includes("/historical-candle/")) {
        return Promise.resolve({ data: { data: { candles: [] } } });
    }
    return originalAxiosGet(url, config);
};

[
    "../services/marketDataService",
    "../utils/instrumentKeyResolver",
    "../services/candleService",
    "../utils/rsiCandles",
    "../utils/backtestEngine",
    "../services/liveCandleFeed",
].forEach((p) => delete require.cache[require.resolve(p)]);

const { fetchLatestClosedCandles } = require("../services/liveCandleFeed");

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

console.log("Workstream J — liveCandleFeed.fetchLatestClosedCandles\n");

(async () => {
    await test("Strips the trailing still-forming bar when less than a full minute has elapsed", async () => {
        const realNow = Date.now;
        Date.now = () => Date.parse("2024-01-02T09:17:30+05:30"); // 30s into the 09:17 bar
        try {
            const candles = await fetchLatestClosedCandles(TEST_KEY, "1m", { maxBars: 50 });
            assert.strictEqual(candles.length, 2);
            assert.strictEqual(candles[candles.length - 1].close, 102.5);
        } finally {
            Date.now = realNow;
        }
    });

    await test("Keeps the latest bar once its full duration has elapsed", async () => {
        const realNow = Date.now;
        Date.now = () => Date.parse("2024-01-02T09:18:00+05:30"); // exactly 1 min after 09:17's open
        try {
            const candles = await fetchLatestClosedCandles(TEST_KEY, "1m", { maxBars: 50 });
            assert.strictEqual(candles.length, 3);
            assert.strictEqual(candles[candles.length - 1].close, 103.5);
        } finally {
            Date.now = realNow;
        }
    });

    await test("Output is normalized to the backtest-quote shape (date/open/high/low/close/volume)", async () => {
        const realNow = Date.now;
        Date.now = () => Date.parse("2024-01-02T09:18:00+05:30");
        try {
            const candles = await fetchLatestClosedCandles(TEST_KEY, "1m", { maxBars: 50 });
            candles.forEach((c) => {
                assert.ok(c.date instanceof Date);
                ["open", "high", "low", "close", "volume"].forEach((field) => assert.ok(Number.isFinite(c[field])));
            });
        } finally {
            Date.now = realNow;
        }
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
