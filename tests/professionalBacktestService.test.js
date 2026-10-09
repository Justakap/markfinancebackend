/**
 * Phase F.5 — exercises the REAL candle-service interface (mocked only at
 * the axios/HTTP boundary, exactly like historicalCandleCache.test.js
 * already does for the legacy engine) through the professional pipeline's
 * own adapter/service, down to schema-validated (but DB-free) persistence.
 * This is the test that proves: real candle-service interface -> indicator
 * engine -> execution engine -> analytics -> persisted BacktestResult ->
 * persisted BacktestTrade.
 */
const assert = require("assert");

process.env.UPSTOX_INSTRUMENT_MASTER_URL = "https://fake.test/pf-instruments.json";
process.env.UPSTOX_ACCESS_TOKEN = "fake-token-for-tests";
process.env.UPSTOX_REQUEST_GAP_MS = "0";
process.env.UPSTOX_MAX_RETRIES = "1";
process.env.UPSTOX_RETRY_BASE_MS = "5";
process.env.UPSTOX_RETRY_MAX_MS = "10";

const axios = require("axios");

const TEST_KEY = "NSE_EQ|PFTEST01";
const TEST_KEY_2 = "NSE_EQ|PFTEST02";
const FAKE_INSTRUMENTS = [
    { instrument_key: TEST_KEY, trading_symbol: "PFTESTSTOCK", exchange: "NSE", instrument_type: "EQ", segment: "NSE_EQ" },
    { instrument_key: TEST_KEY_2, trading_symbol: "PFTESTSTOCK2", exchange: "NSE", instrument_type: "EQ", segment: "NSE_EQ" },
];

function fakeDailyCandles(count) {
    const candles = [];
    for (let i = 0; i < count; i += 1) {
        const close = 100 + Math.sin(i / 5) * 10 + i * 0.1;
        const ts = new Date(2024, 0, 1 + i).toISOString();
        candles.push([ts, close - 0.3, close + 1.2, close - 1.2, close, 1000 + i, 0]);
    }
    return candles;
}

let historicalCallCount = 0;

const originalAxiosGet = axios.get.bind(axios);
axios.get = (url, config) => {
    if (url === process.env.UPSTOX_INSTRUMENT_MASTER_URL) {
        return Promise.resolve({ data: Buffer.from(JSON.stringify(FAKE_INSTRUMENTS), "utf8") });
    }
    if (url.includes("/historical-candle/")) {
        historicalCallCount += 1;
        return Promise.resolve({ data: { data: { candles: fakeDailyCandles(100) } } });
    }
    return originalAxiosGet(url, config);
};

// Fresh requires so every module that captured a reference to axios/env at
// load time picks up the mock/env set above, not whatever a previous test
// file left behind in the shared require cache.
[
    "../services/marketDataService",
    "../services/candleService",
    "../utils/instrumentKeyResolver",
    "../utils/backtestEngine",
    "../services/professionalCandleAdapter",
    "../services/professionalBacktestService",
].forEach((p) => delete require.cache[require.resolve(p)]);

const { runAndPersistBacktest } = require("../services/professionalBacktestService");
const upstoxMarketData = require("../services/marketDataService");
const { resolveInstrumentKey } = require("../utils/instrumentKeyResolver");
const RealBacktestResult = require("../models/BacktestResult");
const RealBacktestTrade = require("../models/BacktestTrade");
const mongoose = require("mongoose");

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

/** Wraps a REAL Phase A Mongoose model so "persistence" is schema-
 *  validated (proving the engine's output actually fits BacktestResult/
 *  BacktestTrade) without requiring a live MongoDB connection. */
function makeRecordingModel(RealModel) {
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
    };
}

function professionalDefinition(overrides = {}) {
    return {
        version: 2,
        name: "F.5 Integration Strategy",
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
        risk: { stopLoss: { type: "percent", value: 8 } },
        execution: { side: "LONG", positionSizing: { type: "percentOfEquity", value: 100 } },
        ...overrides,
    };
}

(async () => {
    console.log("Phase F.5 — professionalBacktestService (real candle-service interface, mocked Upstox network)\n");

    await test("Real candle-service interface -> engine -> analytics -> schema-validated persistence", async () => {
        historicalCallCount = 0;
        const userId = new mongoose.Types.ObjectId();
        const version = {
            _id: new mongoose.Types.ObjectId(),
            versionNumber: 1,
            definition: professionalDefinition(),
        };

        const BacktestResultModel = makeRecordingModel(RealBacktestResult);
        const BacktestTradeModel = makeRecordingModel(RealBacktestTrade);

        const instrumentKey = await resolveInstrumentKey("PFTESTSTOCK", null);
        assert.strictEqual(instrumentKey, TEST_KEY);
        const instrumentMeta = upstoxMarketData.getInstrumentMeta(instrumentKey);

        const { resultDoc, trades, dataQuality } = await runAndPersistBacktest({
            models: { BacktestResult: BacktestResultModel, BacktestTrade: BacktestTradeModel },
            userId,
            version,
            instrumentKey,
            symbol: "PFTESTSTOCK",
            instrumentMeta,
            startDate: new Date(2024, 0, 1),
            endDate: new Date(2024, 3, 1),
            initialCapital: 10000,
            commissionPct: 0.03,
            slippagePct: 0.05,
        });

        assert.ok(historicalCallCount > 0, "expected the real candle-service pipeline to hit the (mocked) Upstox endpoint");
        assert.ok(resultDoc._id, "BacktestResult should have been constructed with an id");
        assert.strictEqual(BacktestResultModel.saved.length, 1);
        assert.ok(Number.isFinite(resultDoc.summary.totalReturnPct));
        assert.strictEqual(resultDoc.tradeCount, trades.length);

        if (trades.length) {
            assert.strictEqual(BacktestTradeModel.saved.length, trades.length);
            BacktestTradeModel.saved.forEach((tradeDoc) => {
                assert.strictEqual(String(tradeDoc.backtestResultId), String(resultDoc._id));
            });
        }

        assert.strictEqual(dataQuality.historicalPeSupported, false);
        assert.ok(dataQuality.corporateActionsNote.length > 0);

        // Phase G-I finding: dataQuality must be persisted onto the
        // BacktestResult document itself, not just returned transiently —
        // otherwise GET /api/v2/backtests/:id (used whenever a result is
        // reopened later) would silently lack these disclosures.
        assert.strictEqual(resultDoc.dataQuality.historicalPeSupported, false);
        assert.strictEqual(resultDoc.dataQuality.corporateActionsNote, dataQuality.corporateActionsNote);

        // Verification-pass audit (2026-10-09): the cost-model disclosure
        // must name the exact commission/slippage rates actually used for
        // THIS run and explicitly state what real-world statutory charges
        // (STT/exchange/GST/SEBI/stamp duty) are not included — never let
        // "net P&L" be presented as if it were real-world-complete.
        assert.ok(dataQuality.tradingCostModelNote.includes("commission 0.03%"));
        assert.ok(dataQuality.tradingCostModelNote.includes("slippage 0.05%"));
        assert.ok(dataQuality.tradingCostModelNote.includes("STT"));
        assert.ok(dataQuality.tradingCostModelNote.includes("GST"));
        assert.ok(dataQuality.tradingCostModelNote.includes("stamp duty"));
        assert.strictEqual(resultDoc.dataQuality.tradingCostModelNote, dataQuality.tradingCostModelNote);
    });

    await test("Ownership/version resolution: service runs fine given a plain StrategyVersion-shaped object (no Mongoose coupling)", async () => {
        const version = { _id: new mongoose.Types.ObjectId(), versionNumber: 2, definition: professionalDefinition() };
        const BacktestResultModel = makeRecordingModel(RealBacktestResult);
        const BacktestTradeModel = makeRecordingModel(RealBacktestTrade);

        const result = await runAndPersistBacktest({
            models: { BacktestResult: BacktestResultModel, BacktestTrade: BacktestTradeModel },
            userId: new mongoose.Types.ObjectId(),
            version,
            instrumentKey: TEST_KEY,
            symbol: "PFTESTSTOCK",
            instrumentMeta: upstoxMarketData.getInstrumentMeta(TEST_KEY),
            startDate: new Date(2024, 0, 1),
            endDate: new Date(2024, 3, 1),
            initialCapital: 5000,
            commissionPct: 0,
            slippagePct: 0,
        });

        assert.ok(result.resultDoc);
    });

    await test("Invalid strategy definition is rejected before any candle fetch", async () => {
        const version = {
            _id: new mongoose.Types.ObjectId(),
            versionNumber: 1,
            definition: { version: 2, universe: { timeframe: "1d" } }, // missing entry
        };
        const before = historicalCallCount;

        await assert.rejects(
            () =>
                runAndPersistBacktest({
                    models: { BacktestResult: makeRecordingModel(RealBacktestResult), BacktestTrade: makeRecordingModel(RealBacktestTrade) },
                    userId: new mongoose.Types.ObjectId(),
                    version,
                    instrumentKey: TEST_KEY,
                    symbol: "PFTESTSTOCK",
                    instrumentMeta: {},
                    startDate: new Date(2024, 0, 1),
                    endDate: new Date(2024, 3, 1),
                    initialCapital: 10000,
                    commissionPct: 0.03,
                    slippagePct: 0.05,
                }),
            /entry/,
        );
        assert.strictEqual(historicalCallCount, before, "no candle fetch should happen for an invalid definition");
    });

    await test("Insufficient historical data is rejected with a clear message", async () => {
        historicalCallCount = 0;
        const originalGet = axios.get;
        axios.get = (url, config) => {
            if (url.includes("/historical-candle/")) {
                historicalCallCount += 1;
                return Promise.resolve({ data: { data: { candles: fakeDailyCandles(3) } } }); // far too few for RSI(14) warmup
            }
            return originalGet(url, config);
        };

        try {
            await assert.rejects(
                () =>
                    runAndPersistBacktest({
                        models: { BacktestResult: makeRecordingModel(RealBacktestResult), BacktestTrade: makeRecordingModel(RealBacktestTrade) },
                        userId: new mongoose.Types.ObjectId(),
                        version: { _id: new mongoose.Types.ObjectId(), versionNumber: 1, definition: professionalDefinition() },
                        instrumentKey: TEST_KEY_2,
                        symbol: "PFTESTSTOCK2",
                        instrumentMeta: {},
                        startDate: new Date(2024, 0, 1),
                        endDate: new Date(2024, 0, 4),
                        initialCapital: 10000,
                        commissionPct: 0,
                        slippagePct: 0,
                    }),
                /Insufficient historical data/,
            );
        } finally {
            axios.get = originalGet;
        }
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
