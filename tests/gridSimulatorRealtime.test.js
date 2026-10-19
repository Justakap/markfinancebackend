/**
 * Grid Trading Simulator — tests for services/gridSimulatorRealtime.js,
 * the event-driven replacement for the old 5-second poll loop (ADR-022).
 * Uses fake GridSimulatorSession/GridSimulatorTrade models (same
 * atomic-findOneAndUpdate convention as gridSimulatorService.test.js) and
 * calls the module's exported internals directly — no real Upstox/Mongo.
 */
const assert = require("assert");
const mongoose = require("mongoose");

process.env.UPSTOX_INSTRUMENT_MASTER_URL = "https://fake.test/grid-simulator-realtime-instruments.json";
delete process.env.UPSTOX_ACCESS_TOKEN;
delete process.env.UPSTOX_TOKEN;

const marketDataService = require("../services/marketDataService");
marketDataService.primeInstrumentsCacheForTests([]);

const realtime = require("../services/gridSimulatorRealtime");

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
    referencePrice: 340,
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
        if (key === "$ne") return true;
        if (cond !== null && typeof cond === "object" && !(cond instanceof Date) && !(cond instanceof mongoose.Types.ObjectId)) {
            if ("$lte" in cond) return doc[key] != null && new Date(doc[key]).getTime() <= new Date(cond.$lte).getTime();
            if ("$ne" in cond) return doc[key] !== cond.$ne;
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

function makeFakeSessionModel(seedDocs = []) {
    const docs = new Map(seedDocs.map((doc) => [String(doc._id), JSON.parse(JSON.stringify(doc))]));
    return {
        docs,
        async create(fields) {
            const doc = { _id: new mongoose.Types.ObjectId(), processingLockedUntil: null, ...JSON.parse(JSON.stringify(fields)) };
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
        async find(filter = {}) {
            return [...docs.values()].filter((doc) => matchFilter(doc, filter)).map((d) => JSON.parse(JSON.stringify(d)));
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
        async find(filter = {}) {
            return docs.filter((doc) => matchFilter(doc, filter));
        },
    };
}

function makeActiveSessionDoc(overrides = {}) {
    return {
        _id: new mongoose.Types.ObjectId(),
        userId: new mongoose.Types.ObjectId(),
        instrumentKey: "NSE_EQ|GICRE",
        symbol: "GICRE",
        status: "ACTIVE",
        config: CONFIG,
        state: {
            cash: CONFIG.startingCapital,
            holdings: 0,
            avgCost: 0,
            realizedPnL: 0,
            lastPrice: null,
            lastEventTimestamp: null,
            levelArmed: {},
            sequence: 0,
            tradeSequence: 0,
        },
        lastFeedStatus: "UNKNOWN",
        lastFeedCheckAt: null,
        lastFeedPrice: null,
        processingLockedUntil: null,
        ...overrides,
    };
}

function makeFakeIo() {
    const emitted = [];
    return {
        emitted,
        to(room) {
            return {
                emit: (event, payload) => emitted.push({ room, event, payload }),
            };
        },
    };
}

(async () => {
    console.log("Grid Trading Simulator — real-time (event-driven) processing\n");

    await test("1. a genuine normalized upstream tick reaches the simulator processor", async () => {
        const session = makeActiveSessionDoc();
        const GridSimulatorSession = makeFakeSessionModel([session]);
        const GridSimulatorTrade = makeFakeTradeModel();
        const io = makeFakeIo();
        realtime.init({ GridSimulatorSession, GridSimulatorTrade, io });
        realtime.registerSession(session);

        realtime.handleUpstreamTick({ instrumentKey: "NSE_EQ|GICRE", ltp: 336, timestamp: Date.now() }, "ws");
        await new Promise((resolve) => setTimeout(resolve, 20)); // let the fire-and-forget processing settle

        const persisted = GridSimulatorSession.docs.get(String(session._id));
        assert.strictEqual(persisted.state.holdings, 100);
        assert.strictEqual(persisted.lastFeedStatus, "LIVE");
        realtime.unregisterSession(session._id);
    });

    await test("2. one tick crossing multiple levels (a gap) creates correctly ordered, uniquely numbered trades", async () => {
        const session = makeActiveSessionDoc();
        const GridSimulatorSession = makeFakeSessionModel([session]);
        const GridSimulatorTrade = makeFakeTradeModel();
        realtime.init({ GridSimulatorSession, GridSimulatorTrade, io: makeFakeIo() });
        realtime.registerSession(session);

        realtime.handleUpstreamTick({ instrumentKey: "NSE_EQ|GICRE", ltp: 310, timestamp: Date.now() }, "ws");
        await new Promise((resolve) => setTimeout(resolve, 20));

        assert.strictEqual(GridSimulatorTrade.docs.length, 10);
        const sequences = GridSimulatorTrade.docs.map((t) => t.sequence);
        assert.strictEqual(new Set(sequences).size, 10, "all sequence numbers must be unique");
        assert.deepStrictEqual([...sequences].sort((a, b) => a - b), sequences, "trades should already be in ascending sequence order");
        realtime.unregisterSession(session._id);
    });

    await test("3. multiple sessions for the SAME instrument do not duplicate-process a tick into each other", async () => {
        const sessionA = makeActiveSessionDoc({ instrumentKey: "NSE_EQ|SHARED" });
        const sessionB = makeActiveSessionDoc({ instrumentKey: "NSE_EQ|SHARED" });
        const GridSimulatorSession = makeFakeSessionModel([sessionA, sessionB]);
        const GridSimulatorTrade = makeFakeTradeModel();
        realtime.init({ GridSimulatorSession, GridSimulatorTrade, io: makeFakeIo() });
        realtime.registerSession(sessionA);
        realtime.registerSession(sessionB);

        realtime.handleUpstreamTick({ instrumentKey: "NSE_EQ|SHARED", ltp: 336, timestamp: Date.now() }, "ws");
        await new Promise((resolve) => setTimeout(resolve, 20));

        const docA = GridSimulatorSession.docs.get(String(sessionA._id));
        const docB = GridSimulatorSession.docs.get(String(sessionB._id));
        assert.strictEqual(docA.state.holdings, 100, "session A processes its own independent grid");
        assert.strictEqual(docB.state.holdings, 100, "session B processes its own independent grid");
        const tradesForA = GridSimulatorTrade.docs.filter((t) => String(t.sessionId) === String(sessionA._id));
        const tradesForB = GridSimulatorTrade.docs.filter((t) => String(t.sessionId) === String(sessionB._id));
        assert.strictEqual(tradesForA.length, 1);
        assert.strictEqual(tradesForB.length, 1);
        realtime.unregisterSession(sessionA._id);
        realtime.unregisterSession(sessionB._id);
    });

    await test("4. different instruments are routed only to the sessions that actually watch them", async () => {
        const sessionA = makeActiveSessionDoc({ instrumentKey: "NSE_EQ|AAA" });
        const sessionB = makeActiveSessionDoc({ instrumentKey: "NSE_EQ|BBB" });
        const GridSimulatorSession = makeFakeSessionModel([sessionA, sessionB]);
        const GridSimulatorTrade = makeFakeTradeModel();
        realtime.init({ GridSimulatorSession, GridSimulatorTrade, io: makeFakeIo() });
        realtime.registerSession(sessionA);
        realtime.registerSession(sessionB);

        realtime.handleUpstreamTick({ instrumentKey: "NSE_EQ|AAA", ltp: 336, timestamp: Date.now() }, "ws");
        await new Promise((resolve) => setTimeout(resolve, 20));

        const docA = GridSimulatorSession.docs.get(String(sessionA._id));
        const docB = GridSimulatorSession.docs.get(String(sessionB._id));
        assert.strictEqual(docA.state.holdings, 100);
        assert.strictEqual(docB.state.holdings, 0, "a tick for a different instrument must never reach this session");
        realtime.unregisterSession(sessionA._id);
        realtime.unregisterSession(sessionB._id);
    });

    await test("5. duplicate/out-of-order ticks never create duplicate or incorrect trades", async () => {
        const session = makeActiveSessionDoc();
        const GridSimulatorSession = makeFakeSessionModel([session]);
        const GridSimulatorTrade = makeFakeTradeModel();
        realtime.init({ GridSimulatorSession, GridSimulatorTrade, io: makeFakeIo() });
        realtime.registerSession(session);

        const now = Date.now();
        realtime.handleUpstreamTick({ instrumentKey: "NSE_EQ|GICRE", ltp: 336, timestamp: now }, "ws");
        await new Promise((resolve) => setTimeout(resolve, 20));
        // Exact duplicate event (same ms) replayed.
        realtime.handleUpstreamTick({ instrumentKey: "NSE_EQ|GICRE", ltp: 336, timestamp: now }, "ws");
        await new Promise((resolve) => setTimeout(resolve, 20));

        const persisted = GridSimulatorSession.docs.get(String(session._id));
        assert.strictEqual(persisted.state.holdings, 100, "the duplicate must not double the fill");
        assert.strictEqual(GridSimulatorTrade.docs.length, 1);
        realtime.unregisterSession(session._id);
    });

    await test("6. existing gap-fill/re-arming/cash/holdings/P&L rules are unchanged under real-time delivery", async () => {
        const session = makeActiveSessionDoc();
        const GridSimulatorSession = makeFakeSessionModel([session]);
        const GridSimulatorTrade = makeFakeTradeModel();
        realtime.init({ GridSimulatorSession, GridSimulatorTrade, io: makeFakeIo() });
        realtime.registerSession(session);

        realtime.handleUpstreamTick({ instrumentKey: "NSE_EQ|GICRE", ltp: 336, timestamp: Date.now() }, "ws"); // buy @337
        await new Promise((resolve) => setTimeout(resolve, 15));
        realtime.handleUpstreamTick({ instrumentKey: "NSE_EQ|GICRE", ltp: 338, timestamp: Date.now() }, "ws"); // re-arm 337
        await new Promise((resolve) => setTimeout(resolve, 15));
        realtime.handleUpstreamTick({ instrumentKey: "NSE_EQ|GICRE", ltp: 345, timestamp: Date.now() }, "ws"); // sell @343
        await new Promise((resolve) => setTimeout(resolve, 15));

        const persisted = GridSimulatorSession.docs.get(String(session._id));
        assert.strictEqual(persisted.state.holdings, 0);
        assert.strictEqual(persisted.state.realizedPnL, 100 * (345 - 336));
        realtime.unregisterSession(session._id);
    });

    await test("7. paused and stopped sessions do not trade on a genuine tick", async () => {
        const session = makeActiveSessionDoc({ status: "PAUSED" });
        const GridSimulatorSession = makeFakeSessionModel([session]);
        const GridSimulatorTrade = makeFakeTradeModel();
        realtime.init({ GridSimulatorSession, GridSimulatorTrade, io: makeFakeIo() });
        // A paused/stopped session should have been unregistered already by
        // the route layer, but prove the processor itself also refuses
        // (defense in depth): register anyway and confirm processTick's own
        // ACTIVE-only claim-lock gate rejects it.
        realtime.registerSession(session);

        realtime.handleUpstreamTick({ instrumentKey: "NSE_EQ|GICRE", ltp: 336, timestamp: Date.now() }, "ws");
        await new Promise((resolve) => setTimeout(resolve, 20));

        const persisted = GridSimulatorSession.docs.get(String(session._id));
        assert.strictEqual(persisted.state.holdings, 0);
        assert.strictEqual(GridSimulatorTrade.docs.length, 0);
        realtime.unregisterSession(session._id);
    });

    await test("10. registering/unregistering a grid session pins/unpins only its own instrument, never disrupting others", async () => {
        marketDataService.instrumentMeta.set("NSE_EQ|WATCHX", { symbol: "WATCHX" });
        marketDataService.instrumentMeta.set("NSE_EQ|GRIDX", { symbol: "GRIDX" });
        marketDataService.subscribedInstruments.clear();
        marketDataService.liveData.clear();
        marketDataService.subscribe(["NSE_EQ|WATCHX"]); // a watchlist's own subscription

        const session = makeActiveSessionDoc({ instrumentKey: "NSE_EQ|GRIDX" });
        realtime.registerSession(session);
        marketDataService.liveData.set("NSE_EQ|GRIDX", { instrumentKey: "NSE_EQ|GRIDX", ltp: 1, timestamp: Date.now() });

        // Watchlist changes, no longer wants WATCHX — must not affect GRIDX.
        marketDataService.subscribe([]);
        assert.ok(marketDataService.liveData.has("NSE_EQ|GRIDX"), "grid simulator's pinned instrument must survive an unrelated watchlist change");

        realtime.unregisterSession(session._id);
        assert.ok(!marketDataService.liveData.has("NSE_EQ|GRIDX"), "unregistering the last session for this instrument should release it");
    });

    await test("11. multiple listener registrations (e.g. init() called twice) do not duplicate backend processing", async () => {
        const session = makeActiveSessionDoc();
        const GridSimulatorSession = makeFakeSessionModel([session]);
        const GridSimulatorTrade = makeFakeTradeModel();
        realtime.init({ GridSimulatorSession, GridSimulatorTrade, io: makeFakeIo() });
        realtime.init({ GridSimulatorSession, GridSimulatorTrade, io: makeFakeIo() }); // simulate a second init() call
        realtime.registerSession(session);

        realtime.handleUpstreamTick({ instrumentKey: "NSE_EQ|GICRE", ltp: 336, timestamp: Date.now() }, "ws");
        await new Promise((resolve) => setTimeout(resolve, 20));

        const persisted = GridSimulatorSession.docs.get(String(session._id));
        assert.strictEqual(persisted.state.holdings, 100, "must not double-fill from a duplicated listener");
        assert.strictEqual(GridSimulatorTrade.docs.length, 1);
        realtime.unregisterSession(session._id);
    });

    await test("13. the staleness watchdog marks a session STALE when no genuine tick has arrived recently, without fabricating a price", async () => {
        const session = makeActiveSessionDoc({ lastFeedStatus: "LIVE" });
        const GridSimulatorSession = makeFakeSessionModel([session]);
        const GridSimulatorTrade = makeFakeTradeModel();
        const io = makeFakeIo();
        realtime.init({ GridSimulatorSession, GridSimulatorTrade, io });
        realtime.registerSession(session);
        realtime.lastTickAtByInstrument.set(session.instrumentKey, Date.now() - (realtime.STALE_THRESHOLD_MS + 5000));

        realtime.runStalenessWatchdog();
        await new Promise((resolve) => setTimeout(resolve, 20));

        const persisted = GridSimulatorSession.docs.get(String(session._id));
        assert.strictEqual(persisted.lastFeedStatus, "STALE");
        assert.strictEqual(persisted.state.holdings, 0, "staleness detection must never itself trigger a trade");
        realtime.unregisterSession(session._id);
    });

    await test("17. resyncFromDb() rebuilds the registry from every currently-ACTIVE session after a (simulated) restart, without duplicating trades", async () => {
        const activeA = makeActiveSessionDoc({ instrumentKey: "NSE_EQ|RESYNC_A" });
        const activeB = makeActiveSessionDoc({ instrumentKey: "NSE_EQ|RESYNC_B" });
        const paused = makeActiveSessionDoc({ instrumentKey: "NSE_EQ|RESYNC_C", status: "PAUSED" });
        const GridSimulatorSession = makeFakeSessionModel([activeA, activeB, paused]);
        const GridSimulatorTrade = makeFakeTradeModel();
        realtime.init({ GridSimulatorSession, GridSimulatorTrade, io: makeFakeIo() });

        // Simulate a fresh process: nothing registered yet.
        const resyncedCount = await realtime.resyncFromDb({ GridSimulatorSession });
        assert.strictEqual(resyncedCount, 2, "only ACTIVE sessions are resynced, not paused ones");
        assert.ok(realtime.sessionsByInstrument.has("NSE_EQ|RESYNC_A"));
        assert.ok(realtime.sessionsByInstrument.has("NSE_EQ|RESYNC_B"));
        assert.ok(!realtime.sessionsByInstrument.has("NSE_EQ|RESYNC_C"), "a paused session must not be resynced into live processing");

        // A genuine tick for a resynced instrument now processes correctly, exactly once.
        realtime.handleUpstreamTick({ instrumentKey: "NSE_EQ|RESYNC_A", ltp: 336, timestamp: Date.now() }, "ws");
        await new Promise((resolve) => setTimeout(resolve, 20));
        const persisted = GridSimulatorSession.docs.get(String(activeA._id));
        assert.strictEqual(persisted.state.holdings, 100);
        assert.strictEqual(GridSimulatorTrade.docs.length, 1);

        realtime.unregisterSession(activeA._id);
        realtime.unregisterSession(activeB._id);
    });

    await test('18a. a genuine WS tick executes a trade; a REST fallbackTick for the same crossing never does (ADR-023)', async () => {
        const session = makeActiveSessionDoc();
        const GridSimulatorSession = makeFakeSessionModel([session]);
        const GridSimulatorTrade = makeFakeTradeModel();
        realtime.init({ GridSimulatorSession, GridSimulatorTrade, io: makeFakeIo() });
        realtime.registerSession(session);

        // A REST-fallback price that WOULD cross a level if it were authoritative.
        realtime.handleUpstreamTick({ instrumentKey: "NSE_EQ|GICRE", ltp: 336, timestamp: Date.now() }, "rest");
        await new Promise((resolve) => setTimeout(resolve, 20));

        let persisted = GridSimulatorSession.docs.get(String(session._id));
        assert.strictEqual(persisted.state.holdings, 0, "a REST fallback tick must never execute a trade");
        assert.strictEqual(persisted.state.lastPrice, null, "the crossing watermark must be untouched by a REST fallback tick");
        assert.strictEqual(persisted.lastFeedStatus, "LIVE_REST_FALLBACK");
        assert.strictEqual(GridSimulatorTrade.docs.length, 0);

        // The SAME price, now as a genuine WS tick, must execute for real.
        realtime.handleUpstreamTick({ instrumentKey: "NSE_EQ|GICRE", ltp: 336, timestamp: Date.now() }, "ws");
        await new Promise((resolve) => setTimeout(resolve, 20));

        persisted = GridSimulatorSession.docs.get(String(session._id));
        assert.strictEqual(persisted.state.holdings, 100);
        assert.strictEqual(persisted.lastFeedStatus, "LIVE");
        assert.strictEqual(GridSimulatorTrade.docs.length, 1);
        realtime.unregisterSession(session._id);
    });

    await test("18b. a REST fallbackTick never updates a session that isn't ACTIVE (no stray feed-status writes)", async () => {
        const session = makeActiveSessionDoc({ status: "PAUSED" });
        const GridSimulatorSession = makeFakeSessionModel([session]);
        const GridSimulatorTrade = makeFakeTradeModel();
        realtime.init({ GridSimulatorSession, GridSimulatorTrade, io: makeFakeIo() });
        realtime.registerSession(session);

        realtime.handleUpstreamTick({ instrumentKey: "NSE_EQ|GICRE", ltp: 336, timestamp: Date.now() }, "rest");
        await new Promise((resolve) => setTimeout(resolve, 20));

        const persisted = GridSimulatorSession.docs.get(String(session._id));
        assert.strictEqual(persisted.lastFeedStatus, "UNKNOWN", "a paused session's feed status should not be touched by fallback ticks");
        realtime.unregisterSession(session._id);
    });

    await test("14. the simulator no longer depends on a 5-second polling loop (no such module/export exists)", () => {
        assert.throws(() => require("../services/gridSimulatorFeed"), /Cannot find module/);
        assert.strictEqual(typeof realtime.registerSession, "function");
        assert.strictEqual(typeof realtime.handleUpstreamTick, "function");
    });

    console.log(`\nGrid simulator realtime tests: ${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
