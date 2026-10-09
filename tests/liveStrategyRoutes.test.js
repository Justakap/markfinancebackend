/**
 * Workstream J — route-level tests for /api/v2/live/*. Invokes the Express
 * handler directly (same technique as professionalBacktestRoute.test.js/
 * professionalBacktestCandles.test.js) against the REAL
 * activateLiveStrategy/deactivateLiveStrategy service functions and
 * in-memory fake models — no live MongoDB, no live Upstox.
 */
const assert = require("assert");
const mongoose = require("mongoose");

const { createLiveStrategyRoutes } = require("../routes/liveStrategyRoutes");
const { activateLiveStrategy, deactivateLiveStrategy } = require("../services/liveStrategyService");
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

function definitionFixture(timeframe = "1d") {
    return {
        version: 2,
        universe: { timeframe },
        entry: { type: "condition", left: { type: "price", field: "close" }, operator: "GT", right: { type: "constant", value: 100 } },
    };
}

/** A thenable that also exposes chainable sort/skip/limit (same
 *  mongoose-query-like shape the route handlers call). */
function makeChainableResult(items) {
    const query = {
        sort() {
            return query;
        },
        skip() {
            return query;
        },
        limit() {
            return query;
        },
        then(resolve, reject) {
            return Promise.resolve(items).then(resolve, reject);
        },
    };
    return query;
}

function makeModels() {
    const strategies = new Map();
    const versions = new Map();
    const runtimes = new Map();
    const signals = [];

    const StrategyDefinition = {
        async findOne(filter) {
            const found = [...strategies.values()].find((s) => String(s._id) === String(filter._id) && String(s.userId) === String(filter.userId));
            return found || null;
        },
    };
    const StrategyVersion = {
        async findOne(filter) {
            const found = [...versions.values()].find((v) => String(v._id) === String(filter._id) && (!filter.strategyId || String(v.strategyId) === String(filter.strategyId)));
            return found || null;
        },
    };
    const LiveStrategyRuntime = {
        async create(doc) {
            const existing = [...runtimes.values()].find(
                (r) => r.status === "ACTIVE" && String(r.userId) === String(doc.userId) && String(r.strategyId) === String(doc.strategyId) && r.instrumentKey === doc.instrumentKey && r.timeframe === doc.timeframe,
            );
            if (existing) {
                const error = new Error("duplicate");
                error.code = 11000;
                throw error;
            }
            const _id = new mongoose.Types.ObjectId();
            const toInsert = { _id, ...doc, createdAt: new Date() };
            runtimes.set(String(_id), toInsert);
            return toInsert;
        },
        async findOne(filter) {
            const found = [...runtimes.values()].find((r) => matchBasic(r, filter));
            return found || null;
        },
        async findOneAndUpdate(filter, update, opts) {
            const found = [...runtimes.values()].find((r) => matchBasic(r, filter));
            if (!found) return null;
            Object.assign(found, update.$set || {});
            runtimes.set(String(found._id), found);
            return opts?.returnDocument === "after" ? found : found;
        },
        find(filter) {
            return makeChainableResult([...runtimes.values()].filter((r) => matchBasic(r, filter)));
        },
        async countDocuments(filter) {
            return [...runtimes.values()].filter((r) => matchBasic(r, filter)).length;
        },
    };
    const LiveStrategySignal = {
        find() {
            return makeChainableResult([...signals]);
        },
        async countDocuments() {
            return signals.length;
        },
    };

    function matchBasic(doc, filter = {}) {
        return Object.entries(filter).every(([key, value]) => {
            if (key === "_id") return String(doc._id) === String(value);
            return String(doc[key]) === String(value);
        });
    }

    return { strategies, versions, runtimes, StrategyDefinition, StrategyVersion, LiveStrategyRuntime, LiveStrategySignal };
}

function router(models, resolveInstrumentKey = async () => "NSE_EQ|LIVEROUTE01") {
    return createLiveStrategyRoutes({
        StrategyDefinition: models.StrategyDefinition,
        StrategyVersion: models.StrategyVersion,
        LiveStrategyRuntime: models.LiveStrategyRuntime,
        LiveStrategySignal: models.LiveStrategySignal,
        requireAuth,
        validateObjectId,
        liveStrategyLimiter: (req, res, next) => next(),
        resolveInstrumentKey,
        activateLiveStrategy,
        deactivateLiveStrategy,
    });
}

console.log("Workstream J — /api/v2/live/* route tests\n");

(async () => {
    await test("Activating a strategy the caller owns succeeds and freezes the current version", async () => {
        const models = makeModels();
        const userId = new mongoose.Types.ObjectId();
        const strategyId = new mongoose.Types.ObjectId();
        const versionId = new mongoose.Types.ObjectId();
        models.strategies.set(String(strategyId), { _id: strategyId, userId, currentVersionId: versionId });
        models.versions.set(String(versionId), { _id: versionId, strategyId, definition: definitionFixture("1d") });

        const r = router(models);
        const handle = finalHandlerFor(r, "post", "/v2/live/activate");
        const req = { user: { mongoId: userId }, body: { strategyId: String(strategyId), symbol: "LIVEROUTESTOCK", timeframe: "1d", initialCapital: 10000 } };
        const res = fakeRes();
        await handle(req, res);

        assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
        assert.strictEqual(res.body.runtime.strategyVersionId.toString(), versionId.toString());
        assert.strictEqual(res.body.runtime.status, "ACTIVE");
    });

    await test("Activating a strategy belonging to another user is rejected with 404", async () => {
        const models = makeModels();
        const ownerId = new mongoose.Types.ObjectId();
        const attackerId = new mongoose.Types.ObjectId();
        const strategyId = new mongoose.Types.ObjectId();
        models.strategies.set(String(strategyId), { _id: strategyId, userId: ownerId, currentVersionId: new mongoose.Types.ObjectId() });

        const r = router(models);
        const handle = finalHandlerFor(r, "post", "/v2/live/activate");
        const req = { user: { mongoId: attackerId }, body: { strategyId: String(strategyId), symbol: "X", timeframe: "1d" } };
        const res = fakeRes();
        await handle(req, res);

        assert.strictEqual(res.statusCode, 404);
    });

    await test("Activating twice for the same strategy/instrument/timeframe is rejected with 409, not a silent duplicate", async () => {
        const models = makeModels();
        const userId = new mongoose.Types.ObjectId();
        const strategyId = new mongoose.Types.ObjectId();
        const versionId = new mongoose.Types.ObjectId();
        models.strategies.set(String(strategyId), { _id: strategyId, userId, currentVersionId: versionId });
        models.versions.set(String(versionId), { _id: versionId, strategyId, definition: definitionFixture("1d") });

        const r = router(models);
        const handle = finalHandlerFor(r, "post", "/v2/live/activate");
        const req = { user: { mongoId: userId }, body: { strategyId: String(strategyId), symbol: "LIVEROUTESTOCK", timeframe: "1d" } };

        const res1 = fakeRes();
        await handle(req, res1);
        assert.strictEqual(res1.statusCode, 201);

        const res2 = fakeRes();
        await handle(req, res2);
        assert.strictEqual(res2.statusCode, 409);

        assert.strictEqual(models.runtimes.size, 1);
    });

    await test("Activating with a timeframe that doesn't match the strategy's authored universe.timeframe is rejected (400)", async () => {
        const models = makeModels();
        const userId = new mongoose.Types.ObjectId();
        const strategyId = new mongoose.Types.ObjectId();
        const versionId = new mongoose.Types.ObjectId();
        models.strategies.set(String(strategyId), { _id: strategyId, userId, currentVersionId: versionId });
        models.versions.set(String(versionId), { _id: versionId, strategyId, definition: definitionFixture("1h") });

        const r = router(models);
        const handle = finalHandlerFor(r, "post", "/v2/live/activate");
        const req = { user: { mongoId: userId }, body: { strategyId: String(strategyId), symbol: "X", timeframe: "1d" } };
        const res = fakeRes();
        await handle(req, res);

        assert.strictEqual(res.statusCode, 400);
    });

    await test("A persisted version whose definition no longer validates is rejected (400), never silently activated", async () => {
        const models = makeModels();
        const userId = new mongoose.Types.ObjectId();
        const strategyId = new mongoose.Types.ObjectId();
        const versionId = new mongoose.Types.ObjectId();
        models.strategies.set(String(strategyId), { _id: strategyId, userId, currentVersionId: versionId });
        // Missing `entry` entirely -> validateStrategyDefinition must reject this.
        models.versions.set(String(versionId), { _id: versionId, strategyId, definition: { version: 2, universe: { timeframe: "1d" } } });

        const r = router(models);
        const handle = finalHandlerFor(r, "post", "/v2/live/activate");
        const req = { user: { mongoId: userId }, body: { strategyId: String(strategyId), symbol: "X", timeframe: "1d" } };
        const res = fakeRes();
        await handle(req, res);

        assert.strictEqual(res.statusCode, 400);
        assert.strictEqual(models.runtimes.size, 0);
    });

    await test("An invalid timeframe value is rejected before any DB lookup", async () => {
        const models = makeModels();
        const r = router(models);
        const handle = finalHandlerFor(r, "post", "/v2/live/activate");
        const req = { user: { mongoId: new mongoose.Types.ObjectId() }, body: { strategyId: String(new mongoose.Types.ObjectId()), symbol: "X", timeframe: "3d" } };
        const res = fakeRes();
        await handle(req, res);

        assert.strictEqual(res.statusCode, 400);
    });

    await test("Malformed strategyId is rejected (400), never reaches a DB query", async () => {
        const models = makeModels();
        const r = router(models);
        const handle = finalHandlerFor(r, "post", "/v2/live/activate");
        const req = { user: { mongoId: new mongoose.Types.ObjectId() }, body: { strategyId: "not-an-id", symbol: "X", timeframe: "1d" } };
        const res = fakeRes();
        await handle(req, res);

        assert.strictEqual(res.statusCode, 400);
    });

    await test("Deactivating another user's runtime is rejected with 404, and it remains ACTIVE", async () => {
        const models = makeModels();
        const ownerId = new mongoose.Types.ObjectId();
        const attackerId = new mongoose.Types.ObjectId();
        const runtimeId = new mongoose.Types.ObjectId();
        models.runtimes.set(String(runtimeId), { _id: runtimeId, userId: ownerId, status: "ACTIVE" });

        const r = router(models);
        const handle = finalHandlerFor(r, "post", "/v2/live/:runtimeId/deactivate");
        const req = { user: { mongoId: attackerId }, params: { runtimeId: String(runtimeId) } };
        const res = fakeRes();
        await handle(req, res);

        assert.strictEqual(res.statusCode, 404);
        assert.strictEqual(models.runtimes.get(String(runtimeId)).status, "ACTIVE");
    });

    await test("Owner can deactivate their own runtime", async () => {
        const models = makeModels();
        const userId = new mongoose.Types.ObjectId();
        const runtimeId = new mongoose.Types.ObjectId();
        models.runtimes.set(String(runtimeId), { _id: runtimeId, userId, status: "ACTIVE" });

        const r = router(models);
        const handle = finalHandlerFor(r, "post", "/v2/live/:runtimeId/deactivate");
        const req = { user: { mongoId: userId }, params: { runtimeId: String(runtimeId) } };
        const res = fakeRes();
        await handle(req, res);

        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.body.runtime.status, "INACTIVE");
    });

    await test("Listing runtimes only returns the authenticated user's own", async () => {
        const models = makeModels();
        const userId = new mongoose.Types.ObjectId();
        const otherId = new mongoose.Types.ObjectId();
        models.runtimes.set("a", { _id: new mongoose.Types.ObjectId(), userId, status: "ACTIVE", config: {}, engineState: {} });
        models.runtimes.set("b", { _id: new mongoose.Types.ObjectId(), userId: otherId, status: "ACTIVE", config: {}, engineState: {} });

        const r = router(models);
        const handle = finalHandlerFor(r, "get", "/v2/live");
        const req = { user: { mongoId: userId }, query: {} };
        const res = fakeRes();
        await handle(req, res);

        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.body.items.length, 1);
    });

    await test("requireAuth is wired on every /v2/live route", () => {
        const models = makeModels();
        const r = router(models);
        ["/v2/live/activate", "/v2/live", "/v2/live/:runtimeId", "/v2/live/:runtimeId/signals"].forEach((path) => {
            const layer = r.stack.find((l) => l.route?.path === path);
            assert.ok(layer.route.stack.some((l) => l.handle === requireAuth), `requireAuth missing on ${path}`);
        });
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
