/**
 * Grid Trading Simulator — route-level tests for
 * routes/gridSimulatorRoutes.js. Invokes the Express handler directly
 * (same technique as professionalStrategyRoutes.test.js) against in-memory
 * fake models, exercised through the REAL services/gridSimulatorService.js
 * so ownership/validation/lifecycle guarantees are tested through the
 * actual code path, not a stand-in for it.
 */
const assert = require("assert");
const mongoose = require("mongoose");

const { createGridSimulatorRoutes } = require("../routes/gridSimulatorRoutes");
const {
    createSession,
    getOwnedSession,
    startSession,
    pauseSession,
    resumeSession,
    stopSession,
    processTick,
    listSessions,
    listTrades,
    getPortfolioMetrics,
} = require("../services/gridSimulatorService");
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
        if (key === "$or") return cond.some((sub) => matchFilter(doc, sub));
        if (cond !== null && typeof cond === "object" && !(cond instanceof Date) && !(cond instanceof mongoose.Types.ObjectId)) {
            if ("$lte" in cond) return doc[key] != null && new Date(doc[key]).getTime() <= new Date(cond.$lte).getTime();
            if ("$in" in cond) return cond.$in.includes(doc[key]);
        }
        if (key === "_id") return String(doc._id) === String(cond);
        if (cond === null) return doc[key] === null || doc[key] === undefined;
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

function makeQuery(initialArr) {
    let arr = initialArr;
    const query = {
        sort(spec) {
            const [key, dir] = Object.entries(spec)[0];
            arr = [...arr].sort((a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0) * dir);
            return query;
        },
        skip(n) {
            arr = arr.slice(n);
            return query;
        },
        limit(n) {
            arr = arr.slice(0, n);
            return query;
        },
        then(resolve, reject) {
            return Promise.resolve(arr.map((d) => JSON.parse(JSON.stringify(d)))).then(resolve, reject);
        },
    };
    return query;
}

function makeFakeModels() {
    const sessions = new Map();
    const trades = [];

    const GridSimulatorSession = {
        async create(fields) {
            const doc = { _id: new mongoose.Types.ObjectId(), processingLockedUntil: null, ...JSON.parse(JSON.stringify(fields)) };
            sessions.set(String(doc._id), doc);
            return JSON.parse(JSON.stringify(doc));
        },
        async findOne(filter = {}) {
            const found = [...sessions.values()].find((doc) => matchFilter(doc, filter));
            return found ? JSON.parse(JSON.stringify(found)) : null;
        },
        async findOneAndUpdate(filter, update, options = {}) {
            const found = [...sessions.values()].find((doc) => matchFilter(doc, filter));
            if (!found) return null;
            if (update.$set) applySet(found, update.$set);
            return options.new ? JSON.parse(JSON.stringify(found)) : null;
        },
        find(filter = {}) {
            return makeQuery([...sessions.values()].filter((doc) => matchFilter(doc, filter)));
        },
        async countDocuments(filter = {}) {
            return [...sessions.values()].filter((doc) => matchFilter(doc, filter)).length;
        },
    };

    const GridSimulatorTrade = {
        async insertMany(items) {
            items.forEach((item) => trades.push({ _id: new mongoose.Types.ObjectId(), ...item }));
            return items;
        },
        find(filter = {}) {
            return makeQuery(trades.filter((doc) => matchFilter(doc, filter)));
        },
        async countDocuments(filter = {}) {
            return trades.filter((doc) => matchFilter(doc, filter)).length;
        },
    };

    return { GridSimulatorSession, GridSimulatorTrade };
}

function makeRouter(models, resolveInstrumentKey = async (symbol, key) => key || `NSE_EQ|${symbol}`) {
    return createGridSimulatorRoutes({
        ...models,
        requireAuth,
        validateObjectId,
        resolveInstrumentKey,
        createSession,
        getOwnedSession,
        startSession,
        pauseSession,
        resumeSession,
        stopSession,
        processTick,
        listSessions,
        listTrades,
        getPortfolioMetrics,
    });
}

function validConfigBody(overrides = {}) {
    return {
        symbol: "GICRE",
        referencePrice: 340,
        gridInterval: 3,
        quantityPerLevel: 100,
        startingCapital: 100000,
        ...overrides,
    };
}

(async () => {
    console.log("Grid Trading Simulator — routes (ownership, validation, lifecycle)\n");

    await test("POST /sessions creates a session for the authenticated user", async () => {
        const models = makeFakeModels();
        const router = makeRouter(models);
        const handle = finalHandlerFor(router, "post", "/v2/grid-simulator/sessions");
        const userId = new mongoose.Types.ObjectId();

        const req = { user: { mongoId: userId }, body: validConfigBody() };
        const res = fakeRes();
        await handle(req, res);

        assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
        assert.strictEqual(res.body.session.status, "CREATED");
        assert.strictEqual(res.body.session.instrumentKey, "NSE_EQ|GICRE");
    });

    await test("POST /sessions rejects a request with neither symbol nor instrumentKey", async () => {
        const models = makeFakeModels();
        const router = makeRouter(models);
        const handle = finalHandlerFor(router, "post", "/v2/grid-simulator/sessions");
        const req = { user: { mongoId: new mongoose.Types.ObjectId() }, body: validConfigBody({ symbol: undefined }) };
        const res = fakeRes();
        await handle(req, res);
        assert.strictEqual(res.statusCode, 400);
    });

    await test("POST /sessions rejects an unresolvable instrument", async () => {
        const models = makeFakeModels();
        const router = makeRouter(models, async () => null);
        const handle = finalHandlerFor(router, "post", "/v2/grid-simulator/sessions");
        const req = { user: { mongoId: new mongoose.Types.ObjectId() }, body: validConfigBody() };
        const res = fakeRes();
        await handle(req, res);
        assert.strictEqual(res.statusCode, 400);
        assert.ok(/No Upstox instrument found/.test(res.body.message));
    });

    await test("POST /sessions rejects an invalid grid configuration with the engine's own error", async () => {
        const models = makeFakeModels();
        const router = makeRouter(models);
        const handle = finalHandlerFor(router, "post", "/v2/grid-simulator/sessions");
        const req = { user: { mongoId: new mongoose.Types.ObjectId() }, body: validConfigBody({ gridInterval: -1 }) };
        const res = fakeRes();
        await handle(req, res);
        assert.strictEqual(res.statusCode, 400);
        assert.ok(/gridInterval/.test(res.body.message));
    });

    await test("POST /sessions rejects a duplicate active session for the same instrument (409)", async () => {
        const models = makeFakeModels();
        const router = makeRouter(models);
        const handle = finalHandlerFor(router, "post", "/v2/grid-simulator/sessions");
        const userId = new mongoose.Types.ObjectId();

        await handle({ user: { mongoId: userId }, body: validConfigBody() }, fakeRes());
        const res2 = fakeRes();
        await handle({ user: { mongoId: userId }, body: validConfigBody() }, res2);
        assert.strictEqual(res2.statusCode, 409);
    });

    await test("GET /sessions only lists the authenticated user's own sessions", async () => {
        const models = makeFakeModels();
        const router = makeRouter(models);
        const createHandle = finalHandlerFor(router, "post", "/v2/grid-simulator/sessions");
        const listHandle = finalHandlerFor(router, "get", "/v2/grid-simulator/sessions");

        const userA = new mongoose.Types.ObjectId();
        const userB = new mongoose.Types.ObjectId();
        await createHandle({ user: { mongoId: userA }, body: validConfigBody({ symbol: "AAA" }) }, fakeRes());
        await createHandle({ user: { mongoId: userB }, body: validConfigBody({ symbol: "BBB" }) }, fakeRes());

        const res = fakeRes();
        await listHandle({ user: { mongoId: userA }, query: {} }, res);
        assert.strictEqual(res.body.items.length, 1);
        assert.strictEqual(res.body.items[0].symbol, "AAA");
    });

    await test("GET /sessions/:sessionId 404s for a session owned by a different user", async () => {
        const models = makeFakeModels();
        const router = makeRouter(models);
        const createHandle = finalHandlerFor(router, "post", "/v2/grid-simulator/sessions");
        const detailHandle = finalHandlerFor(router, "get", "/v2/grid-simulator/sessions/:sessionId");

        const owner = new mongoose.Types.ObjectId();
        const other = new mongoose.Types.ObjectId();
        const createRes = fakeRes();
        await createHandle({ user: { mongoId: owner }, body: validConfigBody() }, createRes);
        const sessionId = createRes.body.session.sessionId;

        const res = fakeRes();
        await detailHandle({ user: { mongoId: other }, params: { sessionId: String(sessionId) } }, res);
        assert.strictEqual(res.statusCode, 404);
    });

    await test("full lifecycle via routes: create -> start -> tick -> pause -> resume -> stop", async () => {
        const models = makeFakeModels();
        const router = makeRouter(models);
        const createHandle = finalHandlerFor(router, "post", "/v2/grid-simulator/sessions");
        const startHandle = finalHandlerFor(router, "post", "/v2/grid-simulator/sessions/:sessionId/start");
        const tickHandle = finalHandlerFor(router, "post", "/v2/grid-simulator/sessions/:sessionId/tick");
        const pauseHandle = finalHandlerFor(router, "post", "/v2/grid-simulator/sessions/:sessionId/pause");
        const resumeHandle = finalHandlerFor(router, "post", "/v2/grid-simulator/sessions/:sessionId/resume");
        const stopHandle = finalHandlerFor(router, "post", "/v2/grid-simulator/sessions/:sessionId/stop");
        const tradesHandle = finalHandlerFor(router, "get", "/v2/grid-simulator/sessions/:sessionId/trades");

        const userId = new mongoose.Types.ObjectId();
        const createRes = fakeRes();
        await createHandle({ user: { mongoId: userId }, body: validConfigBody({ startingCapital: 1000000 }) }, createRes);
        const sessionId = String(createRes.body.session.sessionId);

        const startRes = fakeRes();
        await startHandle({ user: { mongoId: userId }, params: { sessionId } }, startRes);
        assert.strictEqual(startRes.body.session.status, "ACTIVE");

        const tickRes = fakeRes();
        await tickHandle({ user: { mongoId: userId }, params: { sessionId }, body: { price: 336, eventTimestamp: new Date(2026, 0, 1, 9, 15).toISOString() } }, tickRes);
        assert.strictEqual(tickRes.body.trades.length, 1);
        assert.strictEqual(tickRes.body.trades[0].qtyFilled, 100);

        const pauseRes = fakeRes();
        await pauseHandle({ user: { mongoId: userId }, params: { sessionId } }, pauseRes);
        assert.strictEqual(pauseRes.body.session.status, "PAUSED");

        const resumeRes = fakeRes();
        await resumeHandle({ user: { mongoId: userId }, params: { sessionId } }, resumeRes);
        assert.strictEqual(resumeRes.body.session.status, "ACTIVE");

        const stopRes = fakeRes();
        await stopHandle({ user: { mongoId: userId }, params: { sessionId } }, stopRes);
        assert.strictEqual(stopRes.body.session.status, "STOPPED");

        const tradesRes = fakeRes();
        await tradesHandle({ user: { mongoId: userId }, params: { sessionId }, query: {} }, tradesRes);
        assert.strictEqual(tradesRes.body.total, 1);
        assert.strictEqual(tradesRes.body.items[0].isSimulated, true);
    });

    await test("tick endpoint rejects a non-positive price (never fabricates a fill)", async () => {
        const models = makeFakeModels();
        const router = makeRouter(models);
        const createHandle = finalHandlerFor(router, "post", "/v2/grid-simulator/sessions");
        const startHandle = finalHandlerFor(router, "post", "/v2/grid-simulator/sessions/:sessionId/start");
        const tickHandle = finalHandlerFor(router, "post", "/v2/grid-simulator/sessions/:sessionId/tick");

        const userId = new mongoose.Types.ObjectId();
        const createRes = fakeRes();
        await createHandle({ user: { mongoId: userId }, body: validConfigBody() }, createRes);
        const sessionId = String(createRes.body.session.sessionId);
        await startHandle({ user: { mongoId: userId }, params: { sessionId } }, fakeRes());

        const res = fakeRes();
        await tickHandle({ user: { mongoId: userId }, params: { sessionId }, body: { price: -5 } }, res);
        assert.strictEqual(res.statusCode, 400);
    });

    await test("tick endpoint is ownership-scoped (404 for another user's session)", async () => {
        const models = makeFakeModels();
        const router = makeRouter(models);
        const createHandle = finalHandlerFor(router, "post", "/v2/grid-simulator/sessions");
        const startHandle = finalHandlerFor(router, "post", "/v2/grid-simulator/sessions/:sessionId/start");
        const tickHandle = finalHandlerFor(router, "post", "/v2/grid-simulator/sessions/:sessionId/tick");

        const owner = new mongoose.Types.ObjectId();
        const other = new mongoose.Types.ObjectId();
        const createRes = fakeRes();
        await createHandle({ user: { mongoId: owner }, body: validConfigBody() }, createRes);
        const sessionId = String(createRes.body.session.sessionId);
        await startHandle({ user: { mongoId: owner }, params: { sessionId } }, fakeRes());

        const res = fakeRes();
        await tickHandle({ user: { mongoId: other }, params: { sessionId }, body: { price: 336 } }, res);
        assert.strictEqual(res.statusCode, 404);
    });

    console.log(`\nGrid simulator route tests: ${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
