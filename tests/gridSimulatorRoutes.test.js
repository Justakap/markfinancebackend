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
    getTradeCounts,
    getChargesSummary,
    updateSessionConfig,
    deleteSession,
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
            if (update.$inc) {
                Object.entries(update.$inc).forEach(([path, delta]) => {
                    const parts = path.split(".");
                    let target = found;
                    for (let i = 0; i < parts.length - 1; i += 1) {
                        target[parts[i]] = target[parts[i]] || {};
                        target = target[parts[i]];
                    }
                    const last = parts[parts.length - 1];
                    target[last] = (target[last] || 0) + delta;
                });
            }
            return options.new ? JSON.parse(JSON.stringify(found)) : null;
        },
        find(filter = {}) {
            return makeQuery([...sessions.values()].filter((doc) => matchFilter(doc, filter)));
        },
        async countDocuments(filter = {}) {
            return [...sessions.values()].filter((doc) => matchFilter(doc, filter)).length;
        },
        async deleteOne(filter = {}) {
            const found = [...sessions.values()].find((doc) => matchFilter(doc, filter));
            if (found) sessions.delete(String(found._id));
            return { deletedCount: found ? 1 : 0 };
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
        async deleteMany(filter = {}) {
            const toRemove = trades.filter((doc) => matchFilter(doc, filter));
            toRemove.forEach((doc) => {
                const idx = trades.indexOf(doc);
                if (idx !== -1) trades.splice(idx, 1);
            });
            return { deletedCount: toRemove.length };
        },
    };

    return { GridSimulatorSession, GridSimulatorTrade };
}

// Simulates "a fresh quote is always available" for whichever instrument
// is being created — warmLiveQuotes() populates liveData for any key asked
// for, same shape captureFreshReference() expects (ltp + a current
// timestamp). Tests that need to simulate NO fresh quote pass an override.
function makeFakeMarketDataService(overrides = {}) {
    const liveData = new Map();
    return {
        liveData,
        warmLiveQuotes: async (keys = []) => {
            keys.forEach((key) => {
                if (!liveData.has(key)) liveData.set(key, { ltp: 340, timestamp: Date.now() });
            });
        },
        ...overrides,
    };
}

function makeRouter(models, resolveInstrumentKey = async (symbol, key) => key || `NSE_EQ|${symbol}`, marketDataService = makeFakeMarketDataService(), extraDeps = {}) {
    return createGridSimulatorRoutes({
        ...models,
        requireAuth,
        validateObjectId,
        resolveInstrumentKey,
        marketDataService,
        createSession,
        getOwnedSession,
        startSession,
        pauseSession,
        resumeSession,
        stopSession,
        processTick,
        listSessions,
        listTrades,
        getTradeCounts,
        getChargesSummary,
        updateSessionConfig,
        deleteSession,
        getPortfolioMetrics,
        ...extraDeps,
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

    await test("full lifecycle via routes: create -> start -> pause -> resume -> stop", async () => {
        const models = makeFakeModels();
        const router = makeRouter(models);
        const createHandle = finalHandlerFor(router, "post", "/v2/grid-simulator/sessions");
        const startHandle = finalHandlerFor(router, "post", "/v2/grid-simulator/sessions/:sessionId/start");
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
        assert.strictEqual(tradesRes.body.total, 0); // no WS/processTick activity was simulated in this route-level test
    });

    // ADR-028: the frontend-pushed /tick endpoint is DISPLAY-ONLY — a
    // client-relayed price must never reach the authoritative crossing
    // engine (same "only a genuine, backend-verified source is
    // authoritative" rule as ADR-023's REST-fallback restriction). These
    // tests replace the old ones that asserted it executed a trade.
    await test("tick endpoint never executes a trade (display-only, ADR-028)", async () => {
        const models = makeFakeModels();
        const router = makeRouter(models);
        const createHandle = finalHandlerFor(router, "post", "/v2/grid-simulator/sessions");
        const startHandle = finalHandlerFor(router, "post", "/v2/grid-simulator/sessions/:sessionId/start");
        const tickHandle = finalHandlerFor(router, "post", "/v2/grid-simulator/sessions/:sessionId/tick");
        const detailHandle = finalHandlerFor(router, "get", "/v2/grid-simulator/sessions/:sessionId");
        const tradesHandle = finalHandlerFor(router, "get", "/v2/grid-simulator/sessions/:sessionId/trades");

        const userId = new mongoose.Types.ObjectId();
        const createRes = fakeRes();
        await createHandle({ user: { mongoId: userId }, body: validConfigBody({ referencePrice: 340, gridInterval: 3 }) }, createRes);
        const sessionId = String(createRes.body.session.sessionId);
        await startHandle({ user: { mongoId: userId }, params: { sessionId } }, fakeRes());

        // A price that would cross a grid level (340 -> 336 crosses 337) if
        // this endpoint were still authoritative.
        const tickRes = fakeRes();
        await tickHandle({ user: { mongoId: userId }, params: { sessionId }, body: { price: 336 } }, tickRes);
        assert.strictEqual(tickRes.body.skipped, true);
        assert.strictEqual(tickRes.body.reason, "client_tick_display_only");
        assert.deepStrictEqual(tickRes.body.trades, []);

        const detailRes = fakeRes();
        await detailHandle({ user: { mongoId: userId }, params: { sessionId } }, detailRes);
        assert.strictEqual(detailRes.body.portfolio.holdings, 0); // unchanged
        assert.strictEqual(detailRes.body.state.lastPrice, 340); // crossing watermark untouched
        assert.strictEqual(detailRes.body.lastFeedPrice, 336); // display field IS updated

        const tradesRes = fakeRes();
        await tradesHandle({ user: { mongoId: userId }, params: { sessionId }, query: {} }, tradesRes);
        assert.strictEqual(tradesRes.body.total, 0); // no ledger row was created
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

    await test("POST /sessions auto-captures the reference from a fresh live quote, ignoring any client-supplied referencePrice", async () => {
        const models = makeFakeModels();
        const marketDataService = makeFakeMarketDataService();
        marketDataService.liveData.set("NSE_EQ|GICRE", { ltp: 351.25, timestamp: Date.now() });
        const router = makeRouter(models, undefined, marketDataService);
        const handle = finalHandlerFor(router, "post", "/v2/grid-simulator/sessions");

        const res = fakeRes();
        await handle({ user: { mongoId: new mongoose.Types.ObjectId() }, body: validConfigBody({ referencePrice: 999 }) }, res);
        assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
        assert.strictEqual(res.body.session.config.referencePrice, 351.25, "must use the captured live quote, never the client-supplied value");
        assert.ok(res.body.session.config.referenceCapturedAt, "referenceCapturedAt must be persisted");
    });

    await test("POST /sessions rejects creation when no live quote is available at all", async () => {
        const models = makeFakeModels();
        const marketDataService = makeFakeMarketDataService();
        // warmLiveQuotes() is a no-op that never populates liveData for this test.
        marketDataService.warmLiveQuotes = async () => {};
        const router = makeRouter(models, undefined, marketDataService);
        const handle = finalHandlerFor(router, "post", "/v2/grid-simulator/sessions");

        const res = fakeRes();
        await handle({ user: { mongoId: new mongoose.Types.ObjectId() }, body: validConfigBody() }, res);
        assert.strictEqual(res.statusCode, 400);
        assert.ok(/fresh market quote/.test(res.body.message));
    });

    await test("POST /sessions rejects creation when the only available quote is stale", async () => {
        const models = makeFakeModels();
        const marketDataService = makeFakeMarketDataService();
        marketDataService.liveData.set("NSE_EQ|GICRE", { ltp: 340, timestamp: Date.now() - 60_000 }); // 60s old
        marketDataService.warmLiveQuotes = async () => {}; // simulate the warm call not refreshing it (e.g. instrument unreachable)
        const router = makeRouter(models, undefined, marketDataService);
        const handle = finalHandlerFor(router, "post", "/v2/grid-simulator/sessions");

        const res = fakeRes();
        await handle({ user: { mongoId: new mongoose.Types.ObjectId() }, body: validConfigBody() }, res);
        assert.strictEqual(res.statusCode, 400);
        assert.ok(/fresh market quote/.test(res.body.message));
    });

    await test("POST /sessions requires startingAvgCost when startingHoldings > 0", async () => {
        const models = makeFakeModels();
        const router = makeRouter(models);
        const handle = finalHandlerFor(router, "post", "/v2/grid-simulator/sessions");

        const res = fakeRes();
        await handle({ user: { mongoId: new mongoose.Types.ObjectId() }, body: validConfigBody({ startingHoldings: 200 }) }, res);
        assert.strictEqual(res.statusCode, 400);
        assert.ok(/startingAvgCost/.test(res.body.message));
    });

    await test("POST /sessions accepts starting inventory with a user-provided average cost and persists it", async () => {
        const models = makeFakeModels();
        const router = makeRouter(models);
        const handle = finalHandlerFor(router, "post", "/v2/grid-simulator/sessions");

        const res = fakeRes();
        await handle({ user: { mongoId: new mongoose.Types.ObjectId() }, body: validConfigBody({ startingHoldings: 200, startingAvgCost: 315 }) }, res);
        assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
        assert.strictEqual(res.body.session.config.startingHoldings, 200);
        assert.strictEqual(res.body.session.config.startingAvgCost, 315);
    });

    await test("POST /sessions does not require startingAvgCost when startingHoldings is zero (the default)", async () => {
        const models = makeFakeModels();
        const router = makeRouter(models);
        const handle = finalHandlerFor(router, "post", "/v2/grid-simulator/sessions");

        const res = fakeRes();
        await handle({ user: { mongoId: new mongoose.Types.ObjectId() }, body: validConfigBody() }, res);
        assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
    });

    // --- PATCH .../config (ADR-034 live edit) ---

    await test("PATCH .../config rejects editing a session that isn't PAUSED", async () => {
        const models = makeFakeModels();
        const router = makeRouter(models);
        const userId = new mongoose.Types.ObjectId();
        const createRes = fakeRes();
        await finalHandlerFor(router, "post", "/v2/grid-simulator/sessions")({ user: { mongoId: userId }, body: validConfigBody() }, createRes);
        const sessionId = createRes.body.session.sessionId;

        const handle = finalHandlerFor(router, "patch", "/v2/grid-simulator/sessions/:sessionId/config");
        const res = fakeRes();
        await handle({ user: { mongoId: userId }, params: { sessionId }, body: { quantityPerLevel: 50 } }, res);
        assert.strictEqual(res.statusCode, 409, JSON.stringify(res.body));
    });

    await test("PATCH .../config applies quantityPerLevel/gridInterval/addCash, and a separate sellVariance when requested, while PAUSED", async () => {
        const models = makeFakeModels();
        const router = makeRouter(models);
        const userId = new mongoose.Types.ObjectId();

        const createRes = fakeRes();
        await finalHandlerFor(router, "post", "/v2/grid-simulator/sessions")({ user: { mongoId: userId }, body: validConfigBody() }, createRes);
        const sessionId = createRes.body.session.sessionId;

        const startHandle = finalHandlerFor(router, "post", "/v2/grid-simulator/sessions/:sessionId/start");
        await startHandle({ user: { mongoId: userId }, params: { sessionId } }, fakeRes());
        const pauseHandle = finalHandlerFor(router, "post", "/v2/grid-simulator/sessions/:sessionId/pause");
        await pauseHandle({ user: { mongoId: userId }, params: { sessionId } }, fakeRes());

        const handle = finalHandlerFor(router, "patch", "/v2/grid-simulator/sessions/:sessionId/config");
        const res = fakeRes();
        await handle(
            { user: { mongoId: userId }, params: { sessionId }, body: { quantityPerLevel: 40, gridInterval: 5, useSeparateSellVariance: true, sellVariance: 7, addCash: 10000 } },
            res,
        );
        assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
        assert.strictEqual(res.body.session.config.quantityPerLevel, 40);
        assert.strictEqual(res.body.session.config.gridInterval, 5);
        assert.strictEqual(res.body.session.config.sellVariance, 7);
    });

    await test("PATCH .../config applies sellQuantityPerLevel (ADR-035) when useSeparateSellQuantity is true", async () => {
        const models = makeFakeModels();
        const router = makeRouter(models);
        const userId = new mongoose.Types.ObjectId();

        const createRes = fakeRes();
        await finalHandlerFor(router, "post", "/v2/grid-simulator/sessions")({ user: { mongoId: userId }, body: validConfigBody() }, createRes);
        const sessionId = createRes.body.session.sessionId;
        await finalHandlerFor(router, "post", "/v2/grid-simulator/sessions/:sessionId/start")({ user: { mongoId: userId }, params: { sessionId } }, fakeRes());
        await finalHandlerFor(router, "post", "/v2/grid-simulator/sessions/:sessionId/pause")({ user: { mongoId: userId }, params: { sessionId } }, fakeRes());

        const handle = finalHandlerFor(router, "patch", "/v2/grid-simulator/sessions/:sessionId/config");
        const res = fakeRes();
        await handle({ user: { mongoId: userId }, params: { sessionId }, body: { useSeparateSellQuantity: true, sellQuantityPerLevel: 30 } }, res);
        assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
        assert.strictEqual(res.body.session.config.sellQuantityPerLevel, 30);
    });

    await test("PATCH .../config rejects useSeparateSellQuantity:true without a valid sellQuantityPerLevel", async () => {
        const models = makeFakeModels();
        const router = makeRouter(models);
        const userId = new mongoose.Types.ObjectId();

        const createRes = fakeRes();
        await finalHandlerFor(router, "post", "/v2/grid-simulator/sessions")({ user: { mongoId: userId }, body: validConfigBody() }, createRes);
        const sessionId = createRes.body.session.sessionId;
        await finalHandlerFor(router, "post", "/v2/grid-simulator/sessions/:sessionId/start")({ user: { mongoId: userId }, params: { sessionId } }, fakeRes());
        await finalHandlerFor(router, "post", "/v2/grid-simulator/sessions/:sessionId/pause")({ user: { mongoId: userId }, params: { sessionId } }, fakeRes());

        const handle = finalHandlerFor(router, "patch", "/v2/grid-simulator/sessions/:sessionId/config");
        const res = fakeRes();
        await handle({ user: { mongoId: userId }, params: { sessionId }, body: { useSeparateSellQuantity: true } }, res);
        assert.strictEqual(res.statusCode, 400);
    });

    await test("GET /sessions/:sessionId includes a charges summary (ADR-035) keyed by the session's captured segmentClass", async () => {
        const models = makeFakeModels();
        const router = makeRouter(models);
        const userId = new mongoose.Types.ObjectId();

        const createRes = fakeRes();
        await finalHandlerFor(router, "post", "/v2/grid-simulator/sessions")({ user: { mongoId: userId }, body: validConfigBody() }, createRes);
        const sessionId = createRes.body.session.sessionId;

        const detailHandle = finalHandlerFor(router, "get", "/v2/grid-simulator/sessions/:sessionId");
        const res = fakeRes();
        await detailHandle({ user: { mongoId: userId }, params: { sessionId } }, res);
        assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
        assert.ok(res.body.charges, "detail response includes a charges field");
        assert.strictEqual(res.body.charges.segmentClass, "EQUITY_DELIVERY");
        assert.strictEqual(res.body.charges.total, 0, "no trades yet -> zero charges");
    });

    await test("PATCH .../config rejects useSeparateSellVariance:true without a valid sellVariance", async () => {
        const models = makeFakeModels();
        const router = makeRouter(models);
        const userId = new mongoose.Types.ObjectId();

        const createRes = fakeRes();
        await finalHandlerFor(router, "post", "/v2/grid-simulator/sessions")({ user: { mongoId: userId }, body: validConfigBody() }, createRes);
        const sessionId = createRes.body.session.sessionId;
        await finalHandlerFor(router, "post", "/v2/grid-simulator/sessions/:sessionId/start")({ user: { mongoId: userId }, params: { sessionId } }, fakeRes());
        await finalHandlerFor(router, "post", "/v2/grid-simulator/sessions/:sessionId/pause")({ user: { mongoId: userId }, params: { sessionId } }, fakeRes());

        const handle = finalHandlerFor(router, "patch", "/v2/grid-simulator/sessions/:sessionId/config");
        const res = fakeRes();
        await handle({ user: { mongoId: userId }, params: { sessionId }, body: { useSeparateSellVariance: true } }, res);
        assert.strictEqual(res.statusCode, 400);
    });

    await test("PATCH .../config 404s for a different user's session (no cross-user config edits)", async () => {
        const models = makeFakeModels();
        const router = makeRouter(models);
        const owner = new mongoose.Types.ObjectId();
        const other = new mongoose.Types.ObjectId();

        const createRes = fakeRes();
        await finalHandlerFor(router, "post", "/v2/grid-simulator/sessions")({ user: { mongoId: owner }, body: validConfigBody() }, createRes);
        const sessionId = createRes.body.session.sessionId;
        await finalHandlerFor(router, "post", "/v2/grid-simulator/sessions/:sessionId/start")({ user: { mongoId: owner }, params: { sessionId } }, fakeRes());
        await finalHandlerFor(router, "post", "/v2/grid-simulator/sessions/:sessionId/pause")({ user: { mongoId: owner }, params: { sessionId } }, fakeRes());

        const handle = finalHandlerFor(router, "patch", "/v2/grid-simulator/sessions/:sessionId/config");
        const res = fakeRes();
        await handle({ user: { mongoId: other }, params: { sessionId }, body: { quantityPerLevel: 10 } }, res);
        assert.strictEqual(res.statusCode, 404);
    });

    // --- DELETE .../sessions/:sessionId ---

    await test("DELETE .../sessions/:sessionId removes the session (any status) and unregisters it from the realtime registry", async () => {
        const models = makeFakeModels();
        let unregisteredWith = null;
        const router = makeRouter(models, undefined, undefined, { unregisterRealtimeSession: (sessionId) => { unregisteredWith = String(sessionId); } });
        const userId = new mongoose.Types.ObjectId();

        const createRes = fakeRes();
        await finalHandlerFor(router, "post", "/v2/grid-simulator/sessions")({ user: { mongoId: userId }, body: validConfigBody() }, createRes);
        const sessionId = createRes.body.session.sessionId;
        await finalHandlerFor(router, "post", "/v2/grid-simulator/sessions/:sessionId/start")({ user: { mongoId: userId }, params: { sessionId } }, fakeRes());

        const handle = finalHandlerFor(router, "delete", "/v2/grid-simulator/sessions/:sessionId");
        const res = fakeRes();
        await handle({ user: { mongoId: userId }, params: { sessionId } }, res);
        assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
        assert.strictEqual(res.body.success, true);
        assert.strictEqual(unregisteredWith, String(sessionId));

        const detailHandle = finalHandlerFor(router, "get", "/v2/grid-simulator/sessions/:sessionId");
        const detailRes = fakeRes();
        await detailHandle({ user: { mongoId: userId }, params: { sessionId } }, detailRes);
        assert.strictEqual(detailRes.statusCode, 404);
    });

    await test("DELETE .../sessions/:sessionId 404s for a different user's session (no cross-user deletion)", async () => {
        const models = makeFakeModels();
        const router = makeRouter(models);
        const owner = new mongoose.Types.ObjectId();
        const other = new mongoose.Types.ObjectId();

        const createRes = fakeRes();
        await finalHandlerFor(router, "post", "/v2/grid-simulator/sessions")({ user: { mongoId: owner }, body: validConfigBody() }, createRes);
        const sessionId = createRes.body.session.sessionId;

        const handle = finalHandlerFor(router, "delete", "/v2/grid-simulator/sessions/:sessionId");
        const res = fakeRes();
        await handle({ user: { mongoId: other }, params: { sessionId } }, res);
        assert.strictEqual(res.statusCode, 404);
    });

    console.log(`\nGrid simulator route tests: ${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
