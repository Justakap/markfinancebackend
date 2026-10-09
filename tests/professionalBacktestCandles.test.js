/**
 * Historical Candle Chart milestone — GET /api/v2/backtests/:id/candles.
 * Mocks only the axios/HTTP boundary (same technique as
 * historicalCandleCache.test.js/professionalBacktestService.test.js), so
 * the real candleService.fetchHistoricalCandlesByRange path is exercised,
 * not a stand-in for it.
 */
const assert = require("assert");
const mongoose = require("mongoose");

process.env.UPSTOX_INSTRUMENT_MASTER_URL = "https://fake.test/candles-instruments.json";
process.env.UPSTOX_ACCESS_TOKEN = "fake-token-for-tests";
process.env.UPSTOX_REQUEST_GAP_MS = "0";
process.env.UPSTOX_MAX_RETRIES = "1";
process.env.UPSTOX_RETRY_BASE_MS = "5";
process.env.UPSTOX_RETRY_MAX_MS = "10";

const axios = require("axios");

const TEST_KEY = "NSE_EQ|CANDLETEST01";
const FAKE_INSTRUMENTS = [
    { instrument_key: TEST_KEY, trading_symbol: "CANDLETESTSTOCK", exchange: "NSE", instrument_type: "EQ", segment: "NSE_EQ" },
];

let historicalCallCount = 0;
let lastHistoricalUrl = null;
let failNextWith = null;
let failPersistentlyWith = null;

function fakeDailyCandles(count, startDay = 1) {
    const candles = [];
    for (let i = 0; i < count; i += 1) {
        const close = 100 + i * 0.5;
        candles.push([new Date(2024, 0, startDay + i).toISOString(), close - 0.2, close + 1, close - 1, close, 1000 + i, 0]);
    }
    return candles;
}

const originalAxiosGet = axios.get.bind(axios);
axios.get = (url, config) => {
    if (url === process.env.UPSTOX_INSTRUMENT_MASTER_URL) {
        return Promise.resolve({ data: Buffer.from(JSON.stringify(FAKE_INSTRUMENTS), "utf8") });
    }
    if (url.includes("/historical-candle/")) {
        historicalCallCount += 1;
        lastHistoricalUrl = url;
        if (failPersistentlyWith) {
            const error = new Error(`simulated ${failPersistentlyWith}`);
            error.response = { status: failPersistentlyWith, headers: {} };
            error.request = {};
            return Promise.reject(error);
        }
        if (failNextWith) {
            const status = failNextWith;
            failNextWith = null;
            const error = new Error(`simulated ${status}`);
            error.response = { status, headers: {} };
            error.request = {};
            return Promise.reject(error);
        }
        return Promise.resolve({ data: { data: { candles: fakeDailyCandles(400) } } });
    }
    return originalAxiosGet(url, config);
};

[
    "../services/marketDataService",
    "../utils/instrumentKeyResolver",
    "../services/candleService",
    "../utils/backtestEngine",
].forEach((p) => delete require.cache[require.resolve(p)]);

const { createProfessionalBacktestRoutes } = require("../routes/professionalBacktestRoutes");
const { requireAuth } = require("../middleware/auth");
const { validateObjectId } = require("../middleware/validateObjectId");
const upstoxMarketData = require("../services/marketDataService");
const { resolveInstrumentKey } = require("../utils/instrumentKeyResolver");
const { fetchHistoricalCandlesByRange, toBacktestQuote } = require("../services/candleService");
const { INTERVAL_TO_UPSTOX, INTERVAL_CONFIG } = require("../utils/backtestEngine");

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

function fakeRes() {
    return {
        statusCode: null,
        body: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(payload) {
            if (this.statusCode === null) this.statusCode = 200;
            this.body = payload;
            return this;
        },
    };
}

function finalHandlerFor(router, method, path) {
    const layer = router.stack.find((l) => l.route?.path === path && l.route.methods[method]);
    return layer.route.stack.at(-1).handle;
}

function makeBacktestResultModel(doc) {
    return {
        async findOne(filter) {
            return doc && String(doc._id) === String(filter._id) && String(doc.userId) === String(filter.userId) ? doc : null;
        },
    };
}

function router() {
    return createProfessionalBacktestRoutes({
        StrategyDefinition: {},
        StrategyVersion: {},
        BacktestResult: makeBacktestResultModel(currentDoc),
        BacktestTrade: {},
        requireAuth,
        validateObjectId,
        backtestLimiter: (req, res, next) => next(),
        resolveInstrumentKey,
        upstoxMarketData,
        runAndPersistBacktest: async () => {},
        fetchHistoricalCandlesByRange,
        toBacktestQuote,
        INTERVAL_TO_UPSTOX,
        INTERVAL_CONFIG,
    });
}

let currentDoc = null;

function sampleBacktestResult(overrides = {}) {
    return {
        _id: new mongoose.Types.ObjectId(),
        userId: new mongoose.Types.ObjectId(),
        instrumentKey: TEST_KEY,
        symbol: "CANDLETESTSTOCK",
        timeframe: "1d",
        // Date-only ISO strings parse as UTC midnight per spec, matching
        // exactly how the real run route stores dateRange (new Date(req.body.startDate),
        // itself a "YYYY-MM-DD" string) — unlike new Date(y,m,d), which is
        // local-time and would shift by a day once re-serialized through
        // toISOString() on a server not in UTC.
        dateRange: { from: new Date("2024-01-01"), to: new Date("2024-01-31") },
        ...overrides,
    };
}

(async () => {
    console.log("Historical Candle Chart — GET /api/v2/backtests/:id/candles\n");

    await test("Valid request returns normalized OHLCV candles bounded to the backtest's own date range", async () => {
        historicalCallCount = 0;
        lastHistoricalUrl = null;
        currentDoc = sampleBacktestResult();
        const r = router();
        const handle = finalHandlerFor(r, "get", "/v2/backtests/:id/candles");

        const req = { user: { mongoId: currentDoc.userId }, params: { id: String(currentDoc._id) } };
        const res = fakeRes();
        await handle(req, res);

        assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
        assert.strictEqual(res.body.instrumentKey, TEST_KEY);
        assert.strictEqual(res.body.timeframe, "1d");
        assert.ok(res.body.candles.timestamps.length > 0);
        assert.strictEqual(res.body.candles.timestamps.length, res.body.candles.close.length);
        assert.strictEqual(historicalCallCount, 1, "expected exactly one Upstox call");

        // The date-range fetch must use the BACKTEST's own stored dates,
        // not "today" — this is the whole point of using
        // fetchHistoricalCandlesByRange instead of the relative-to-now
        // fetchCandleSeriesForBacktest. (URL is .../{toDate}/{fromDate}.)
        assert.ok(lastHistoricalUrl.includes("/2024-01-31/2024-01-01"), lastHistoricalUrl);
    });

    await test("Candle normalization: every bar has finite OHLCV values, no NaN/undefined", async () => {
        currentDoc = sampleBacktestResult();
        const r = router();
        const handle = finalHandlerFor(r, "get", "/v2/backtests/:id/candles");
        const res = fakeRes();
        await handle({ user: { mongoId: currentDoc.userId }, params: { id: String(currentDoc._id) } }, res);

        const { open, high, low, close, volume } = res.body.candles;
        [open, high, low, close, volume].forEach((arr) => {
            arr.forEach((v) => assert.ok(Number.isFinite(v)));
        });
    });

    await test("Response size is capped (bounded to the configured max bar count)", async () => {
        currentDoc = sampleBacktestResult({ dateRange: { from: new Date(2020, 0, 1), to: new Date(2024, 0, 1) } });
        const r = router();
        const handle = finalHandlerFor(r, "get", "/v2/backtests/:id/candles");
        const res = fakeRes();
        await handle({ user: { mongoId: currentDoc.userId }, params: { id: String(currentDoc._id) } }, res);

        assert.ok(res.body.candleCount <= 2500);
    });

    await test("A backtest belonging to another user is rejected with 404 (ownership enforced in the query)", async () => {
        currentDoc = sampleBacktestResult();
        const r = router();
        const handle = finalHandlerFor(r, "get", "/v2/backtests/:id/candles");
        const res = fakeRes();
        await handle({ user: { mongoId: new mongoose.Types.ObjectId() }, params: { id: String(currentDoc._id) } }, res);

        assert.strictEqual(res.statusCode, 404);
    });

    await test("A malformed/failing Upstox response is mapped to a safe status, never leaking raw error text", async () => {
        currentDoc = sampleBacktestResult();
        failPersistentlyWith = 503; // exhausts retries -> the route must actually see and map this
        const r = router();
        const handle = finalHandlerFor(r, "get", "/v2/backtests/:id/candles");
        const res = fakeRes();
        try {
            await handle({ user: { mongoId: currentDoc.userId }, params: { id: String(currentDoc._id) } }, res);
        } finally {
            failPersistentlyWith = null;
        }

        assert.strictEqual(res.statusCode, 503);
        assert.ok(!res.body.message.includes("simulated 503"));
    });

    await test("requireAuth is wired on the candles route", () => {
        const r = router();
        const layer = r.stack.find((l) => l.route?.path === "/v2/backtests/:id/candles");
        assert.ok(layer.route.stack.some((l) => l.handle === requireAuth));
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
