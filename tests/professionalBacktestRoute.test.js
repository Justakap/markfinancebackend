/**
 * Phase F.5 — route-level tests for POST /api/v2/backtest/run and its
 * companion GET routes. Invokes the Express handler directly (same
 * technique routes/optionChainRoutes.js's tests already established in
 * this codebase) rather than spinning up a real HTTP server — this
 * exercises the actual validation/ownership/error-mapping/response-shaping
 * logic without needing a real JWT or a live server socket.
 */
const assert = require("assert");
const mongoose = require("mongoose");

process.env.UPSTOX_INSTRUMENT_MASTER_URL = "https://fake.test/pf-route-instruments.json";
process.env.UPSTOX_ACCESS_TOKEN = "fake-token-for-tests";
process.env.UPSTOX_REQUEST_GAP_MS = "0";
process.env.UPSTOX_MAX_RETRIES = "1";
process.env.UPSTOX_RETRY_BASE_MS = "5";
process.env.UPSTOX_RETRY_MAX_MS = "10";

const axios = require("axios");

const TEST_KEY = "NSE_EQ|PFROUTE01";
const FAKE_INSTRUMENTS = [
    { instrument_key: TEST_KEY, trading_symbol: "PFROUTESTOCK", exchange: "NSE", instrument_type: "EQ", segment: "NSE_EQ" },
];

function fakeDailyCandles(count) {
    const candles = [];
    for (let i = 0; i < count; i += 1) {
        const close = 100 + Math.sin(i / 5) * 10 + i * 0.1;
        candles.push([new Date(2024, 0, 1 + i).toISOString(), close - 0.3, close + 1.2, close - 1.2, close, 1000 + i, 0]);
    }
    return candles;
}

const originalAxiosGet = axios.get.bind(axios);
axios.get = (url, config) => {
    if (url === process.env.UPSTOX_INSTRUMENT_MASTER_URL) {
        return Promise.resolve({ data: Buffer.from(JSON.stringify(FAKE_INSTRUMENTS), "utf8") });
    }
    if (url.includes("/historical-candle/")) {
        return Promise.resolve({ data: { data: { candles: fakeDailyCandles(100) } } });
    }
    return originalAxiosGet(url, config);
};

[
    "../services/marketDataService",
    "../utils/instrumentKeyResolver",
    "../services/candleService",
    "../utils/backtestEngine",
    "../services/professionalCandleAdapter",
    "../services/professionalBacktestService",
].forEach((p) => delete require.cache[require.resolve(p)]);

const { createProfessionalBacktestRoutes } = require("../routes/professionalBacktestRoutes");
const { requireAuth } = require("../middleware/auth");
const { validateObjectId } = require("../middleware/validateObjectId");
const { runAndPersistBacktest: realRunAndPersistBacktest } = require("../services/professionalBacktestService");
const upstoxMarketData = require("../services/marketDataService");
const { resolveInstrumentKey } = require("../utils/instrumentKeyResolver");
const RealBacktestResult = require("../models/BacktestResult");
const RealBacktestTrade = require("../models/BacktestTrade");

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
            this.body = payload;
            return this;
        },
    };
}

function finalHandlerFor(router, method, path) {
    const layer = router.stack.find((l) => l.route?.path === path && l.route.methods[method]);
    return layer.route.stack.at(-1).handle;
}

function recordingModel(RealModel) {
    const saved = [];
    return {
        saved,
        async create(data) {
            const doc = new RealModel(data);
            const error = doc.validateSync();
            if (error) throw error;
            saved.push(doc);
            return doc;
        },
        async insertMany(docs) {
            const hydrated = docs.map((d) => {
                const doc = new RealModel(d);
                const error = doc.validateSync();
                if (error) throw error;
                return doc;
            });
            saved.push(...hydrated);
            return hydrated;
        },
        async find() {
            return { sort: () => ({ select: () => ({ limit: () => Promise.resolve(saved) }) }) };
        },
        async findOne(filter) {
            return saved.find((d) => String(d._id) === String(filter._id) && String(d.userId) === String(filter.userId)) || null;
        },
    };
}

function professionalDefinition() {
    return {
        version: 2,
        name: "Route Test Strategy",
        universe: { timeframe: "1d" },
        entry: {
            type: "condition",
            left: { type: "indicator", name: "RSI", params: { period: 14 } },
            operator: "LT",
            right: { type: "constant", value: 40 },
        },
        exit: {
            type: "condition",
            left: { type: "indicator", name: "RSI", params: { period: 14 } },
            operator: "GT",
            right: { type: "constant", value: 60 },
        },
        execution: { side: "LONG", positionSizing: { type: "percentOfEquity", value: 100 } },
    };
}

function makeStrategyFakes({ ownerId, versionDefinition = professionalDefinition() }) {
    const strategyId = new mongoose.Types.ObjectId();
    const versionId = new mongoose.Types.ObjectId();

    const strategy = { _id: strategyId, userId: ownerId, name: "Route Test Strategy", currentVersionId: versionId };
    const version = { _id: versionId, strategyId, versionNumber: 1, definition: versionDefinition };

    const StrategyDefinition = {
        async findOne(filter) {
            return String(filter._id) === String(strategyId) && String(filter.userId) === String(ownerId) ? strategy : null;
        },
    };
    const StrategyVersion = {
        async findOne(filter) {
            return String(filter._id) === String(version._id) && String(filter.strategyId) === String(strategyId) ? version : null;
        },
    };

    return { strategyId, versionId, StrategyDefinition, StrategyVersion };
}

(async () => {
    console.log("Phase F.5 — professional backtest route\n");

    await test("Authenticated, owned strategy: a complete backtest runs end to end through the real handler + real service", async () => {
        const ownerId = new mongoose.Types.ObjectId();
        const { strategyId, StrategyDefinition, StrategyVersion } = makeStrategyFakes({ ownerId });
        const BacktestResult = recordingModel(RealBacktestResult);
        const BacktestTrade = recordingModel(RealBacktestTrade);

        const router = createProfessionalBacktestRoutes({
            StrategyDefinition,
            StrategyVersion,
            BacktestResult,
            BacktestTrade,
            requireAuth,
            validateObjectId,
            backtestLimiter: (req, res, next) => next(),
            resolveInstrumentKey,
            upstoxMarketData,
            runAndPersistBacktest: realRunAndPersistBacktest,
        });
        const handle = finalHandlerFor(router, "post", "/v2/backtest/run");

        const req = {
            user: { mongoId: ownerId },
            body: {
                strategyId: String(strategyId),
                symbol: "PFROUTESTOCK",
                startDate: "2024-01-01",
                endDate: "2024-04-01",
                initialCapital: 10000,
            },
        };
        const res = fakeRes();
        await handle(req, res);

        assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
        assert.ok(res.body.backtestResultId);
        assert.strictEqual(res.body.strategy.strategyId, strategyId);
        assert.ok(Number.isFinite(res.body.summary.totalReturnPct));
        assert.ok(Array.isArray(res.body.equityCurve.equity));
        assert.ok(res.body.dataQuality.corporateActionsNote.length > 0);
        assert.strictEqual(res.body.dataQuality.historicalPeSupported, false);
        assert.ok(typeof res.body.tradeCount === "number");
    });

    await test("Strategy belonging to a different user is rejected (404, not a leak)", async () => {
        const ownerId = new mongoose.Types.ObjectId();
        const attackerId = new mongoose.Types.ObjectId();
        const { strategyId, StrategyDefinition, StrategyVersion } = makeStrategyFakes({ ownerId });

        const router = createProfessionalBacktestRoutes({
            StrategyDefinition,
            StrategyVersion,
            BacktestResult: recordingModel(RealBacktestResult),
            BacktestTrade: recordingModel(RealBacktestTrade),
            requireAuth,
            validateObjectId,
            backtestLimiter: (req, res, next) => next(),
            resolveInstrumentKey,
            upstoxMarketData,
            runAndPersistBacktest: async () => {
                throw new Error("should never be called for an unowned strategy");
            },
        });
        const handle = finalHandlerFor(router, "post", "/v2/backtest/run");

        const req = {
            user: { mongoId: attackerId },
            body: { strategyId: String(strategyId), symbol: "PFROUTESTOCK", startDate: "2024-01-01", endDate: "2024-04-01" },
        };
        const res = fakeRes();
        await handle(req, res);

        assert.strictEqual(res.statusCode, 404);
        assert.strictEqual(res.body.message, "Strategy not found");
    });

    await test("A versionId that doesn't belong to the given strategy is rejected", async () => {
        const ownerId = new mongoose.Types.ObjectId();
        const { strategyId, StrategyDefinition, StrategyVersion } = makeStrategyFakes({ ownerId });
        const foreignVersionId = new mongoose.Types.ObjectId();

        const router = createProfessionalBacktestRoutes({
            StrategyDefinition,
            StrategyVersion,
            BacktestResult: recordingModel(RealBacktestResult),
            BacktestTrade: recordingModel(RealBacktestTrade),
            requireAuth,
            validateObjectId,
            backtestLimiter: (req, res, next) => next(),
            resolveInstrumentKey,
            upstoxMarketData,
            runAndPersistBacktest: async () => {
                throw new Error("should never be called for a foreign version id");
            },
        });
        const handle = finalHandlerFor(router, "post", "/v2/backtest/run");

        const req = {
            user: { mongoId: ownerId },
            body: {
                strategyId: String(strategyId),
                versionId: String(foreignVersionId),
                symbol: "PFROUTESTOCK",
                startDate: "2024-01-01",
                endDate: "2024-04-01",
            },
        };
        const res = fakeRes();
        await handle(req, res);

        assert.strictEqual(res.statusCode, 404);
        assert.strictEqual(res.body.message, "Strategy version not found");
    });

    await test("Invalid instrument is rejected (resolveInstrumentKey returns null)", async () => {
        const ownerId = new mongoose.Types.ObjectId();
        const { strategyId, StrategyDefinition, StrategyVersion } = makeStrategyFakes({ ownerId });

        const router = createProfessionalBacktestRoutes({
            StrategyDefinition,
            StrategyVersion,
            BacktestResult: recordingModel(RealBacktestResult),
            BacktestTrade: recordingModel(RealBacktestTrade),
            requireAuth,
            validateObjectId,
            backtestLimiter: (req, res, next) => next(),
            resolveInstrumentKey: async () => null,
            upstoxMarketData,
            runAndPersistBacktest: async () => {
                throw new Error("should never be called without a resolved instrument");
            },
        });
        const handle = finalHandlerFor(router, "post", "/v2/backtest/run");

        const req = {
            user: { mongoId: ownerId },
            body: { strategyId: String(strategyId), symbol: "DOES_NOT_EXIST", startDate: "2024-01-01", endDate: "2024-04-01" },
        };
        const res = fakeRes();
        await handle(req, res);

        assert.strictEqual(res.statusCode, 400);
    });

    await test("Invalid date range (start >= end) is rejected before any ownership lookup", async () => {
        const router = createProfessionalBacktestRoutes({
            StrategyDefinition: { findOne: async () => { throw new Error("should not be reached"); } },
            StrategyVersion: {},
            BacktestResult: {},
            BacktestTrade: {},
            requireAuth,
            validateObjectId,
            backtestLimiter: (req, res, next) => next(),
            resolveInstrumentKey,
            upstoxMarketData,
            runAndPersistBacktest: async () => {},
        });
        const handle = finalHandlerFor(router, "post", "/v2/backtest/run");

        const req = {
            user: { mongoId: new mongoose.Types.ObjectId() },
            body: {
                strategyId: String(new mongoose.Types.ObjectId()),
                symbol: "X",
                startDate: "2024-04-01",
                endDate: "2024-01-01",
            },
        };
        const res = fakeRes();
        await handle(req, res);

        assert.strictEqual(res.statusCode, 400);
        assert.match(res.body.message, /startDate must be before endDate/);
    });

    await test("Malformed strategyId is rejected (400, never reaches a DB query)", async () => {
        const router = createProfessionalBacktestRoutes({
            StrategyDefinition: { findOne: async () => { throw new Error("should not be reached"); } },
            StrategyVersion: {},
            BacktestResult: {},
            BacktestTrade: {},
            requireAuth,
            validateObjectId,
            backtestLimiter: (req, res, next) => next(),
            resolveInstrumentKey,
            upstoxMarketData,
            runAndPersistBacktest: async () => {},
        });
        const handle = finalHandlerFor(router, "post", "/v2/backtest/run");

        const req = {
            user: { mongoId: new mongoose.Types.ObjectId() },
            body: { strategyId: "not-an-object-id", symbol: "X", startDate: "2024-01-01", endDate: "2024-04-01" },
        };
        const res = fakeRes();
        await handle(req, res);

        assert.strictEqual(res.statusCode, 400);
    });

    await test("Upstox/candle-service failure surfaces as a safe 503, never the raw error", async () => {
        const ownerId = new mongoose.Types.ObjectId();
        const { strategyId, StrategyDefinition, StrategyVersion } = makeStrategyFakes({ ownerId });

        const router = createProfessionalBacktestRoutes({
            StrategyDefinition,
            StrategyVersion,
            BacktestResult: recordingModel(RealBacktestResult),
            BacktestTrade: recordingModel(RealBacktestTrade),
            requireAuth,
            validateObjectId,
            backtestLimiter: (req, res, next) => next(),
            resolveInstrumentKey: async () => TEST_KEY,
            upstoxMarketData,
            runAndPersistBacktest: async () => {
                const error = new Error("simulated upstream failure");
                error.response = { status: 503 };
                throw error;
            },
        });
        const handle = finalHandlerFor(router, "post", "/v2/backtest/run");

        const req = {
            user: { mongoId: ownerId },
            body: { strategyId: String(strategyId), symbol: "PFROUTESTOCK", startDate: "2024-01-01", endDate: "2024-04-01" },
        };
        const res = fakeRes();
        await handle(req, res);

        assert.strictEqual(res.statusCode, 503);
        assert.ok(!res.body.message.includes("simulated upstream failure"), "must not leak the raw upstream error text");
    });

    await test("Backtest execution failure (service throws statusCode 500) surfaces safely", async () => {
        const ownerId = new mongoose.Types.ObjectId();
        const { strategyId, StrategyDefinition, StrategyVersion } = makeStrategyFakes({ ownerId });

        const router = createProfessionalBacktestRoutes({
            StrategyDefinition,
            StrategyVersion,
            BacktestResult: recordingModel(RealBacktestResult),
            BacktestTrade: recordingModel(RealBacktestTrade),
            requireAuth,
            validateObjectId,
            backtestLimiter: (req, res, next) => next(),
            resolveInstrumentKey: async () => TEST_KEY,
            upstoxMarketData,
            runAndPersistBacktest: async () => {
                const error = new Error("Backtest execution failed");
                error.statusCode = 500;
                error.clientMessage = "Backtest execution failed";
                throw error;
            },
        });
        const handle = finalHandlerFor(router, "post", "/v2/backtest/run");

        const req = {
            user: { mongoId: ownerId },
            body: { strategyId: String(strategyId), symbol: "PFROUTESTOCK", startDate: "2024-01-01", endDate: "2024-04-01" },
        };
        const res = fakeRes();
        await handle(req, res);

        assert.strictEqual(res.statusCode, 500);
        assert.strictEqual(res.body.message, "Backtest execution failed");
    });

    await test("requireAuth is actually wired on the run route (no accidental bypass)", () => {
        const router = createProfessionalBacktestRoutes({
            StrategyDefinition: {},
            StrategyVersion: {},
            BacktestResult: {},
            BacktestTrade: {},
            requireAuth,
            validateObjectId,
            backtestLimiter: (req, res, next) => next(),
            resolveInstrumentKey,
            upstoxMarketData,
            runAndPersistBacktest: async () => {},
        });
        const layer = router.stack.find((l) => l.route?.path === "/v2/backtest/run");
        assert.ok(layer.route.stack.some((l) => l.handle === requireAuth));
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
