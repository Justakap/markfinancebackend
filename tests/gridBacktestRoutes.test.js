/**
 * Grid Backtest — route-level tests, exercised through the REAL service
 * functions (same convention as gridSimulatorRoutes.test.js /
 * professionalStrategyRoutes.test.js) against in-memory fake models and an
 * injected fetchRange — no real Upstox/Mongo, no production database.
 */
const assert = require("assert");
const mongoose = require("mongoose");

const { createGridBacktestRoutes } = require("../routes/gridBacktestRoutes");
const {
    runGridBacktest,
    getOwnedBacktest,
    listBacktests,
    listBacktestTrades,
} = require("../services/gridBacktestService");
const { requireAuth } = require("../middleware/auth");
const { validateObjectId } = require("../middleware/validateObjectId");

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

function matchFilter(doc, filter = {}) {
    return Object.entries(filter).every(([key, cond]) => {
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
            const arr = [...docs.values()].filter((doc) => matchFilter(doc, filter));
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
            const arr = docs.filter((doc) => matchFilter(doc, filter));
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

const SOME_CANDLES = [
    candle("2024-01-01", { open: 320, high: 320, low: 320, close: 320 }),
    candle("2024-01-02", { open: 320, high: 320, low: 317, close: 317 }),
];

function makeRouter(models, resolveInstrumentKey = async (symbol, key) => key || `NSE_EQ|${symbol}`, fetchRange) {
    return createGridBacktestRoutes({
        ...models,
        requireAuth,
        validateObjectId,
        resolveInstrumentKey,
        runGridBacktest,
        getOwnedBacktest,
        listBacktests,
        listBacktestTrades,
        fetchRange: fetchRange || (async () => ({ candles: SOME_CANDLES, incomplete: false, failedRanges: [], retentionClamped: false, retentionFrom: null })),
    });
}

function validConfigBody(overrides = {}) {
    return {
        symbol: "GICRE",
        timeframe: "1d",
        requestedStartDate: "2024-01-01",
        requestedEndDate: "2024-01-02",
        gridInterval: 3,
        quantityPerLevel: 100,
        startingCapital: 100000,
        ...overrides,
    };
}

(async () => {
    console.log("Grid Backtest — routes (ownership, validation, persistence)\n");

    await test("POST /backtests runs and returns a COMPLETED backtest", async () => {
        const models = { GridBacktestResult: makeFakeResultModel(), GridBacktestTrade: makeFakeTradeModel() };
        const router = makeRouter(models);
        const handle = finalHandlerFor(router, "post", "/v2/grid-backtest/backtests");

        const res = fakeRes();
        await handle({ user: { mongoId: new mongoose.Types.ObjectId() }, body: validConfigBody() }, res);
        assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
        assert.strictEqual(res.body.backtest.status, "COMPLETED");
        assert.strictEqual(res.body.backtest.initialReference.price, 320);
    });

    await test("POST /backtests rejects a request with neither symbol nor instrumentKey", async () => {
        const models = { GridBacktestResult: makeFakeResultModel(), GridBacktestTrade: makeFakeTradeModel() };
        const router = makeRouter(models);
        const handle = finalHandlerFor(router, "post", "/v2/grid-backtest/backtests");
        const res = fakeRes();
        await handle({ user: { mongoId: new mongoose.Types.ObjectId() }, body: validConfigBody({ symbol: undefined }) }, res);
        assert.strictEqual(res.statusCode, 400);
    });

    await test("POST /backtests rejects an invalid date range with the engine's own error", async () => {
        const models = { GridBacktestResult: makeFakeResultModel(), GridBacktestTrade: makeFakeTradeModel() };
        const router = makeRouter(models);
        const handle = finalHandlerFor(router, "post", "/v2/grid-backtest/backtests");
        const res = fakeRes();
        await handle({ user: { mongoId: new mongoose.Types.ObjectId() }, body: validConfigBody({ requestedStartDate: "2024-02-01", requestedEndDate: "2024-01-01" }) }, res);
        assert.strictEqual(res.statusCode, 400);
    });

    await test("POST /backtests requires startingAvgCost when startingHoldings > 0", async () => {
        const models = { GridBacktestResult: makeFakeResultModel(), GridBacktestTrade: makeFakeTradeModel() };
        const router = makeRouter(models);
        const handle = finalHandlerFor(router, "post", "/v2/grid-backtest/backtests");
        const res = fakeRes();
        await handle({ user: { mongoId: new mongoose.Types.ObjectId() }, body: validConfigBody({ startingHoldings: 200 }) }, res);
        assert.strictEqual(res.statusCode, 400);
    });

    await test("POST /backtests rejects an unresolvable instrument", async () => {
        const models = { GridBacktestResult: makeFakeResultModel(), GridBacktestTrade: makeFakeTradeModel() };
        const router = makeRouter(models, async () => null);
        const handle = finalHandlerFor(router, "post", "/v2/grid-backtest/backtests");
        const res = fakeRes();
        await handle({ user: { mongoId: new mongoose.Types.ObjectId() }, body: validConfigBody() }, res);
        assert.strictEqual(res.statusCode, 400);
    });

    await test("POST /backtests returns 400 (not 500) when no historical data is available, and still persists a FAILED record", async () => {
        const models = { GridBacktestResult: makeFakeResultModel(), GridBacktestTrade: makeFakeTradeModel() };
        const router = makeRouter(models, undefined, async () => ({ candles: [], incomplete: false, failedRanges: [], retentionClamped: false, retentionFrom: null }));
        const handle = finalHandlerFor(router, "post", "/v2/grid-backtest/backtests");
        const res = fakeRes();
        await handle({ user: { mongoId: new mongoose.Types.ObjectId() }, body: validConfigBody() }, res);
        assert.strictEqual(res.statusCode, 400);
        assert.strictEqual([...models.GridBacktestResult.docs.values()][0].status, "FAILED");
    });

    await test("GET /backtests only lists the authenticated user's own backtests", async () => {
        const models = { GridBacktestResult: makeFakeResultModel(), GridBacktestTrade: makeFakeTradeModel() };
        const router = makeRouter(models);
        const createHandle = finalHandlerFor(router, "post", "/v2/grid-backtest/backtests");
        const listHandle = finalHandlerFor(router, "get", "/v2/grid-backtest/backtests");

        const userA = new mongoose.Types.ObjectId();
        const userB = new mongoose.Types.ObjectId();
        await createHandle({ user: { mongoId: userA }, body: validConfigBody({ symbol: "AAA" }) }, fakeRes());
        await createHandle({ user: { mongoId: userB }, body: validConfigBody({ symbol: "BBB" }) }, fakeRes());

        const res = fakeRes();
        await listHandle({ user: { mongoId: userA }, query: {} }, res);
        assert.strictEqual(res.body.items.length, 1);
        assert.strictEqual(res.body.items[0].symbol, "AAA");
    });

    await test("GET /backtests/:id 404s for a backtest owned by a different user (no cross-user access to private results)", async () => {
        const models = { GridBacktestResult: makeFakeResultModel(), GridBacktestTrade: makeFakeTradeModel() };
        const router = makeRouter(models);
        const createHandle = finalHandlerFor(router, "post", "/v2/grid-backtest/backtests");
        const detailHandle = finalHandlerFor(router, "get", "/v2/grid-backtest/backtests/:backtestId");

        const owner = new mongoose.Types.ObjectId();
        const other = new mongoose.Types.ObjectId();
        const createRes = fakeRes();
        await createHandle({ user: { mongoId: owner }, body: validConfigBody() }, createRes);
        const backtestId = String(createRes.body.backtest.backtestId);

        const res = fakeRes();
        await detailHandle({ user: { mongoId: other }, params: { backtestId } }, res);
        assert.strictEqual(res.statusCode, 404);
    });

    await test("GET /backtests/:id/trades is ownership-scoped and returns the persisted ledger", async () => {
        const models = { GridBacktestResult: makeFakeResultModel(), GridBacktestTrade: makeFakeTradeModel() };
        const router = makeRouter(models);
        const createHandle = finalHandlerFor(router, "post", "/v2/grid-backtest/backtests");
        const tradesHandle = finalHandlerFor(router, "get", "/v2/grid-backtest/backtests/:backtestId/trades");

        const userId = new mongoose.Types.ObjectId();
        const createRes = fakeRes();
        await createHandle({ user: { mongoId: userId }, body: validConfigBody() }, createRes);
        const backtestId = String(createRes.body.backtest.backtestId);

        const res = fakeRes();
        await tradesHandle({ user: { mongoId: userId }, params: { backtestId }, query: {} }, res);
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.body.items.length, 1); // one BUY at 317 from the SOME_CANDLES fixture
        assert.strictEqual(res.body.items[0].isSimulated, true);

        const otherRes = fakeRes();
        await tradesHandle({ user: { mongoId: new mongoose.Types.ObjectId() }, params: { backtestId }, query: {} }, otherRes);
        assert.strictEqual(otherRes.statusCode, 404);
    });

    console.log(`\nGrid backtest route tests: ${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
