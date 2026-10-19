/**
 * Grid Backtest — service-layer tests (validation, finer-grained fallback
 * orchestration, persistence, accounting reconciliation). Uses fake
 * GridBacktestResult/GridBacktestTrade models (same atomic-findOneAndUpdate
 * convention as the rest of this test suite) and an injected `fetchRange`
 * so nothing here touches real Upstox/Mongo — no production database.
 */
const assert = require("assert");
const mongoose = require("mongoose");

const {
    validateBacktestRequest,
    runGridBacktest,
    getOwnedBacktest,
    listBacktests,
    listBacktestTrades,
    computeTotalCosts,
    computeTradeCounts,
} = require("../services/gridBacktestService");

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

const CONFIG = {
    gridInterval: 3,
    quantityPerLevel: 100,
    startingCapital: 1000000,
    maxPositionSize: null,
    commissionPct: 0,
    slippagePct: 0,
};

function matchFilter(doc, filter = {}) {
    return Object.entries(filter).every(([key, cond]) => {
        if (key === "$or") return cond.some((sub) => matchFilter(doc, sub));
        if (cond !== null && typeof cond === "object" && !(cond instanceof Date) && !(cond instanceof mongoose.Types.ObjectId)) {
            if ("$in" in cond) return cond.$in.includes(String(doc[key]));
        }
        if (key === "_id") return String(doc._id) === String(cond);
        return String(doc[key]) === String(cond);
    });
}

function applySet(doc, setOps = {}) {
    Object.entries(setOps).forEach(([path, value]) => {
        const parts = path.split(".");
        let target = doc;
        for (let i = 0; i < parts.length - 1; i += 1) {
            target[parts[i]] = target[parts[i]] || {};
            target = target[parts[i]];
        }
        target[parts[parts.length - 1]] = value;
    });
}

function makeFakeResultModel() {
    const docs = new Map();
    return {
        docs,
        async create(fields) {
            const doc = { _id: new mongoose.Types.ObjectId(), ...JSON.parse(JSON.stringify(fields)) };
            docs.set(String(doc._id), doc);
            return JSON.parse(JSON.stringify(doc));
        },
        async findOne(filter = {}) {
            const found = [...docs.values()].find((doc) => matchFilter(doc, filter));
            return found ? JSON.parse(JSON.stringify(found)) : null;
        },
        async findOneAndUpdate(filter, update, options = {}) {
            const found = [...docs.values()].find((doc) => matchFilter(doc, filter));
            if (!found) return null;
            if (update.$set) applySet(found, update.$set);
            return options.new ? JSON.parse(JSON.stringify(found)) : null;
        },
        find(filter = {}) {
            let arr = [...docs.values()].filter((doc) => matchFilter(doc, filter));
            return {
                sort: () => ({
                    skip: (n) => ({
                        limit: (m) => Promise.resolve(arr.slice(n, n + m).map((d) => JSON.parse(JSON.stringify(d)))),
                    }),
                }),
            };
        },
        async countDocuments(filter = {}) {
            return [...docs.values()].filter((doc) => matchFilter(doc, filter)).length;
        },
    };
}

function makeFakeTradeModel() {
    const docs = [];
    return {
        docs,
        async insertMany(items) {
            items.forEach((item) => docs.push({ _id: new mongoose.Types.ObjectId(), ...item }));
            return items;
        },
        find(filter = {}) {
            let arr = docs.filter((doc) => matchFilter(doc, filter));
            return {
                sort: () => ({
                    skip: (n) => ({
                        limit: (m) => Promise.resolve(arr.slice(n, n + m)),
                    }),
                }),
            };
        },
        async countDocuments(filter = {}) {
            return docs.filter((doc) => matchFilter(doc, filter)).length;
        },
    };
}

function candle(dateStr, { open, high, low, close }) {
    return { timestamp: new Date(`${dateStr}T09:15:00.000Z`).toISOString(), open, high, low, close };
}

// --- validation ---

test("validateBacktestRequest rejects an unsupported timeframe", () => {
    const r = validateBacktestRequest({ timeframe: "3m", requestedStartDate: "2024-01-01", requestedEndDate: "2024-02-01", config: CONFIG });
    assert.strictEqual(r.valid, false);
});

test("validateBacktestRequest rejects start >= end", () => {
    const r = validateBacktestRequest({ timeframe: "1d", requestedStartDate: "2024-02-01", requestedEndDate: "2024-01-01", config: CONFIG });
    assert.strictEqual(r.valid, false);
});

test("validateBacktestRequest rejects malformed dates", () => {
    const r = validateBacktestRequest({ timeframe: "1d", requestedStartDate: "not-a-date", requestedEndDate: "2024-01-01", config: CONFIG });
    assert.strictEqual(r.valid, false);
});

test("validateBacktestRequest rejects a span exceeding the timeframe's max", () => {
    const r = validateBacktestRequest({ timeframe: "1m", requestedStartDate: "2020-01-01", requestedEndDate: "2024-01-01", config: CONFIG });
    assert.strictEqual(r.valid, false);
});

test("validateBacktestRequest rejects starting holdings without an average purchase price", () => {
    const r = validateBacktestRequest({ timeframe: "1d", requestedStartDate: "2024-01-01", requestedEndDate: "2024-02-01", config: { ...CONFIG, startingHoldings: 200 } });
    assert.strictEqual(r.valid, false);
});

test("validateBacktestRequest accepts a valid request", () => {
    const r = validateBacktestRequest({ timeframe: "1d", requestedStartDate: "2024-01-01", requestedEndDate: "2024-02-01", config: CONFIG });
    assert.strictEqual(r.valid, true);
});

(async () => {
    // --- runGridBacktest: happy path, initial reference, persistence ---

    await test("runGridBacktest captures the initial reference from the first valid candle's close (not the live price)", async () => {
        const GridBacktestResult = makeFakeResultModel();
        const GridBacktestTrade = makeFakeTradeModel();
        const candles = [
            candle("2024-01-01", { open: 320, high: 320, low: 317, close: 317 }),
            candle("2024-01-02", { open: 317, high: 317, low: 314, close: 314 }),
        ];
        const fetchRange = async () => ({ candles, incomplete: false, failedRanges: [], retentionClamped: false, retentionFrom: null });

        const result = await runGridBacktest({
            GridBacktestResult, GridBacktestTrade,
            userId: new mongoose.Types.ObjectId(), instrumentKey: "NSE_EQ|TEST", symbol: "TEST",
            timeframe: "1d", requestedStartDate: "2024-01-01", requestedEndDate: "2024-01-02",
            config: CONFIG, fetchRange,
        });

        assert.strictEqual(result.status, "COMPLETED");
        assert.strictEqual(result.initialReference.price, 317, "the CLOSE of the first candle, never its open or the live price");
        assert.strictEqual(new Date(result.initialReference.timestamp).getTime(), new Date(candles[0].timestamp).getTime());
    });

    await test("runGridBacktest: exact oscillation 320 -> 317 -> 314 -> 317 -> 320 via daily candles", async () => {
        const GridBacktestResult = makeFakeResultModel();
        const GridBacktestTrade = makeFakeTradeModel();
        const candles = [
            candle("2024-01-01", { open: 320, high: 320, low: 320, close: 320 }), // reference candle
            candle("2024-01-02", { open: 320, high: 320, low: 317, close: 317 }),
            candle("2024-01-03", { open: 317, high: 317, low: 314, close: 314 }),
            candle("2024-01-04", { open: 314, high: 317, low: 314, close: 317 }),
            candle("2024-01-05", { open: 317, high: 320, low: 317, close: 320 }),
        ];
        const fetchRange = async () => ({ candles, incomplete: false, failedRanges: [], retentionClamped: false, retentionFrom: null });

        const result = await runGridBacktest({
            GridBacktestResult, GridBacktestTrade,
            userId: new mongoose.Types.ObjectId(), instrumentKey: "NSE_EQ|OSC", symbol: "OSC",
            timeframe: "1d", requestedStartDate: "2024-01-01", requestedEndDate: "2024-01-05",
            config: CONFIG, fetchRange,
        });

        assert.strictEqual(result.status, "COMPLETED");
        assert.strictEqual(result.initialReference.price, 320);
        const trades = GridBacktestTrade.docs.filter((t) => String(t.backtestId) === String(result._id));
        // ADR-031 (trailing/rebasing reference): every leg of this oscillation
        // trades, since the reference rebases after each crossing — see
        // gridSimulatorEngine.js's/gridBacktestEngine.test.js's own
        // equivalent oscillation tests for the full reasoning.
        assert.strictEqual(trades.length, 4);
        assert.deepStrictEqual(trades.map((t) => t.type), ["BUY", "BUY", "SELL", "SELL"]);
        assert.strictEqual(result.finalState.holdings, 0); // bought 2 lots, sold 2 lots
    });

    await test("runGridBacktest rejects when no historical data is available", async () => {
        const GridBacktestResult = makeFakeResultModel();
        const GridBacktestTrade = makeFakeTradeModel();
        const fetchRange = async () => ({ candles: [], incomplete: false, failedRanges: [], retentionClamped: false, retentionFrom: null });

        await assert.rejects(
            () => runGridBacktest({
                GridBacktestResult, GridBacktestTrade,
                userId: new mongoose.Types.ObjectId(), instrumentKey: "NSE_EQ|EMPTY", symbol: "EMPTY",
                timeframe: "1d", requestedStartDate: "2024-01-01", requestedEndDate: "2024-01-05",
                config: CONFIG, fetchRange,
            }),
            (err) => err.statusCode === 400,
        );
        // A FAILED result must still be persisted, not silently absent.
        const results = [...GridBacktestResult.docs.values()];
        assert.strictEqual(results.length, 1);
        assert.strictEqual(results[0].status, "FAILED");
        assert.ok(results[0].error);
    });

    await test("runGridBacktest discloses when the first available candle is later than the requested start", async () => {
        const GridBacktestResult = makeFakeResultModel();
        const GridBacktestTrade = makeFakeTradeModel();
        // Requested from 2024-01-01, but data only actually starts 2024-01-10.
        const candles = [candle("2024-01-10", { open: 300, high: 300, low: 300, close: 300 })];
        const fetchRange = async () => ({ candles, incomplete: false, failedRanges: [], retentionClamped: false, retentionFrom: null });

        const result = await runGridBacktest({
            GridBacktestResult, GridBacktestTrade,
            userId: new mongoose.Types.ObjectId(), instrumentKey: "NSE_EQ|LATE", symbol: "LATE",
            timeframe: "1d", requestedStartDate: "2024-01-01", requestedEndDate: "2024-01-15",
            config: CONFIG, fetchRange,
        });
        assert.strictEqual(result.config.requestedStartDate, "2024-01-01");
        assert.strictEqual(result.dataQuality.actualStartDate, "2024-01-10");
        assert.notStrictEqual(result.config.requestedStartDate, result.dataQuality.actualStartDate);
    });

    await test("runGridBacktest uses finer-grained candles when available, discloses it, and marks trades as genuinely observed", async () => {
        const GridBacktestResult = makeFakeResultModel();
        const GridBacktestTrade = makeFakeTradeModel();
        const coarseCandles = [candle("2024-01-01", { open: 320, high: 330, low: 310, close: 320 })]; // ambiguous
        const finerCandles = [
            candle("2024-01-01", { open: 320, high: 320, low: 317, close: 317 }),
            candle("2024-01-01", { open: 317, high: 317, low: 314, close: 314 }),
        ];
        let callCount = 0;
        const fetchRange = async (key, unit) => {
            callCount += 1;
            if (unit === "hours") return { candles: finerCandles, incomplete: false, failedRanges: [], retentionClamped: false, retentionFrom: null };
            return { candles: coarseCandles, incomplete: false, failedRanges: [], retentionClamped: false, retentionFrom: null };
        };

        const result = await runGridBacktest({
            GridBacktestResult, GridBacktestTrade,
            userId: new mongoose.Types.ObjectId(), instrumentKey: "NSE_EQ|FINER", symbol: "FINER",
            timeframe: "1d", requestedStartDate: "2024-01-01", requestedEndDate: "2024-01-02",
            config: CONFIG, fetchRange,
        });

        assert.strictEqual(result.dataQuality.usedFinerGrainedCandles, true);
        assert.strictEqual(result.dataQuality.usedTimeframe, "1h");
        assert.strictEqual(result.dataQuality.intrabarAssumption, "observed-finer-grained");
        const trades = GridBacktestTrade.docs.filter((t) => String(t.backtestId) === String(result._id));
        trades.forEach((t) => assert.strictEqual(t.assumedIntrabar, false));
        assert.ok(callCount >= 2);
    });

    await test("runGridBacktest falls back to the conservative assumption when finer data is unavailable, and discloses it", async () => {
        const GridBacktestResult = makeFakeResultModel();
        const GridBacktestTrade = makeFakeTradeModel();
        const coarseCandles = [candle("2024-01-01", { open: 320, high: 320, low: 317, close: 320 })];
        const fetchRange = async (key, unit) => {
            if (unit === "hours") return { candles: [], incomplete: false, failedRanges: [], retentionClamped: false, retentionFrom: null };
            return { candles: coarseCandles, incomplete: false, failedRanges: [], retentionClamped: false, retentionFrom: null };
        };

        const result = await runGridBacktest({
            GridBacktestResult, GridBacktestTrade,
            userId: new mongoose.Types.ObjectId(), instrumentKey: "NSE_EQ|FALLBACK", symbol: "FALLBACK",
            timeframe: "1d", requestedStartDate: "2024-01-01", requestedEndDate: "2024-01-02",
            config: CONFIG, fetchRange,
        });

        assert.strictEqual(result.dataQuality.usedFinerGrainedCandles, false);
        assert.strictEqual(result.dataQuality.usedTimeframe, "1d");
        assert.strictEqual(result.dataQuality.intrabarAssumption, "conservative-open-low-high-close");
        const trades = GridBacktestTrade.docs.filter((t) => String(t.backtestId) === String(result._id));
        trades.forEach((t) => assert.strictEqual(t.assumedIntrabar, true));
    });

    await test("runGridBacktest discloses incomplete/retention-clamped coverage, never silently reporting partial history as complete", async () => {
        const GridBacktestResult = makeFakeResultModel();
        const GridBacktestTrade = makeFakeTradeModel();
        const candles = [candle("2024-01-01", { open: 320, high: 320, low: 320, close: 320 })];
        const fetchRange = async () => ({ candles, incomplete: true, failedRanges: [{ fromDate: "2023-06-01", toDate: "2023-12-31" }], retentionClamped: true, retentionFrom: "2022-01-01" });

        const result = await runGridBacktest({
            GridBacktestResult, GridBacktestTrade,
            userId: new mongoose.Types.ObjectId(), instrumentKey: "NSE_EQ|PARTIAL", symbol: "PARTIAL",
            timeframe: "1h", requestedStartDate: "2023-01-01", requestedEndDate: "2024-01-02",
            config: CONFIG, fetchRange,
        });

        assert.strictEqual(result.dataQuality.incomplete, true);
        assert.strictEqual(result.dataQuality.failedRanges.length, 1);
        assert.strictEqual(result.dataQuality.retentionClamped, true);
        assert.strictEqual(result.dataQuality.retentionFrom, "2022-01-01");
    });

    await test("starting inventory + accounting reconciles by hand (200 @ 315, sell 100 @ 320)", async () => {
        const GridBacktestResult = makeFakeResultModel();
        const GridBacktestTrade = makeFakeTradeModel();
        const candles = [
            candle("2024-01-01", { open: 317, high: 317, low: 317, close: 317 }), // reference = 317, interval 3 -> sell level 320
            candle("2024-01-02", { open: 317, high: 320, low: 317, close: 320 }),
        ];
        const fetchRange = async () => ({ candles, incomplete: false, failedRanges: [], retentionClamped: false, retentionFrom: null });

        const result = await runGridBacktest({
            GridBacktestResult, GridBacktestTrade,
            userId: new mongoose.Types.ObjectId(), instrumentKey: "NSE_EQ|INV", symbol: "INV",
            timeframe: "1d", requestedStartDate: "2024-01-01", requestedEndDate: "2024-01-02",
            config: { ...CONFIG, startingHoldings: 200, startingAvgCost: 315 }, fetchRange,
        });

        assert.strictEqual(result.status, "COMPLETED");
        assert.strictEqual(result.finalState.holdings, 100);
        // Hand calc: realizedPnL = 100 * (320 - 315) = 500.
        assert.strictEqual(result.finalState.realizedPnL, 500);
        assert.strictEqual(result.metrics.realizedPnL, 500);
    });

    await test("computeTotalCosts and computeTradeCounts reconcile with a hand-built trade sequence", () => {
        const trades = [
            { type: "BUY", qtyFilled: 100, fillPrice: 100, cashAfter: 1000000 - 10010 }, // paid 10010 for notional 10000 -> cost 10
            { type: "SELL", qtyFilled: 50, fillPrice: 110, cashAfter: 1000000 - 10010 + 5495 }, // notional 5500, received 5495 -> cost 5
            { type: "BUY", qtyFilled: 0, fillPrice: 90, cashAfter: 1000000 - 10010 + 5495, qtySkipped: 100, reason: "insufficient_cash" },
        ];
        const totalCosts = computeTotalCosts(trades, 1000000);
        assert.strictEqual(totalCosts, 15);
        const counts = computeTradeCounts(trades);
        assert.strictEqual(counts.buyCount, 1);
        assert.strictEqual(counts.sellCount, 1);
        assert.strictEqual(counts.skippedCount, 1);
    });

    // --- ownership / listing ---

    await test("getOwnedBacktest 404s for a different user", async () => {
        const GridBacktestResult = makeFakeResultModel();
        const owner = new mongoose.Types.ObjectId();
        const other = new mongoose.Types.ObjectId();
        const doc = await GridBacktestResult.create({ userId: owner, instrumentKey: "X", symbol: "X", status: "COMPLETED", config: {} });
        await assert.rejects(
            () => getOwnedBacktest({ GridBacktestResult, backtestId: doc._id, userId: other }),
            (err) => err.statusCode === 404,
        );
    });

    await test("listBacktests only returns the authenticated user's own backtests", async () => {
        const GridBacktestResult = makeFakeResultModel();
        const userA = new mongoose.Types.ObjectId();
        const userB = new mongoose.Types.ObjectId();
        await GridBacktestResult.create({ userId: userA, instrumentKey: "A", symbol: "A", status: "COMPLETED", config: {} });
        await GridBacktestResult.create({ userId: userB, instrumentKey: "B", symbol: "B", status: "COMPLETED", config: {} });

        const { items, total } = await listBacktests({ GridBacktestResult, userId: userA, page: 1, limit: 20 });
        assert.strictEqual(total, 1);
        assert.strictEqual(items[0].symbol, "A");
    });

    console.log(`\nGrid backtest service tests: ${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
