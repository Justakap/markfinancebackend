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

    await test("6. existing gap-fill/rebasing/cash/holdings/P&L rules are unchanged under real-time delivery", async () => {
        const session = makeActiveSessionDoc();
        const GridSimulatorSession = makeFakeSessionModel([session]);
        const GridSimulatorTrade = makeFakeTradeModel();
        realtime.init({ GridSimulatorSession, GridSimulatorTrade, io: makeFakeIo() });
        realtime.registerSession(session);

        realtime.handleUpstreamTick({ instrumentKey: "NSE_EQ|GICRE", ltp: 336, timestamp: Date.now() }, "ws"); // buy @337, rebase -> 337
        await new Promise((resolve) => setTimeout(resolve, 15));
        realtime.handleUpstreamTick({ instrumentKey: "NSE_EQ|GICRE", ltp: 338, timestamp: Date.now() }, "ws"); // within the 337 band, no new level crossed
        await new Promise((resolve) => setTimeout(resolve, 15));
        realtime.handleUpstreamTick({ instrumentKey: "NSE_EQ|GICRE", ltp: 345, timestamp: Date.now() }, "ws"); // crosses 340 (sells the 100 held) then 343 (skipped, nothing left)
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

    // --- Repeated-SELL-at-the-same-level regression suite (root cause:
    // the frontend-pushed /tick "accelerant" used to feed a client-relayed,
    // potentially stale price into the SAME authoritative processTick() the
    // genuine WS stream uses. The dedup watermark only rejects an exact-or-
    // earlier TIMESTAMP, not a stale PRICE, so a late/low client-relayed
    // price could re-arm an already-disarmed level, and the next genuine WS
    // tick would re-fire the same signal. Fixed by making the client-pushed
    // tick display-only (ADR-028, see routes/gridSimulatorRoutes.js) — these
    // tests exercise the real-time WS-only path directly, through the real
    // engine, with no mocking of the crossing logic itself. ---

    await test("A. repeated genuine ticks that fluctuate without crossing a NEW level never repeat a trade", async () => {
        const session = makeActiveSessionDoc();
        const GridSimulatorSession = makeFakeSessionModel([session]);
        const GridSimulatorTrade = makeFakeTradeModel();
        realtime.init({ GridSimulatorSession, GridSimulatorTrade, io: makeFakeIo() });
        realtime.registerSession(session);

        // First genuine upward crossing of 337 (reference 340, grid 3,
        // level n=-1 buy at 337) — fires a BUY.
        realtime.handleUpstreamTick({ instrumentKey: "NSE_EQ|GICRE", ltp: 337, timestamp: Date.now() }, "ws");
        await new Promise((resolve) => setTimeout(resolve, 15));
        // Fluctuate ABOVE 337 (never dip back below it) several times —
        // none of these should re-fire the same level.
        for (const ltp of [337.3, 337.6, 337.3, 337.15]) {
            realtime.handleUpstreamTick({ instrumentKey: "NSE_EQ|GICRE", ltp, timestamp: Date.now() }, "ws");
            // eslint-disable-next-line no-await-in-loop
            await new Promise((resolve) => setTimeout(resolve, 15));
        }

        assert.strictEqual(GridSimulatorTrade.docs.length, 1, "only the first genuine crossing should have produced a trade");
        realtime.unregisterSession(session._id);
    });

    await test("B. insufficient holdings: one skipped SELL, reference advances, no repeat on later non-crossing ticks", async () => {
        const session = makeActiveSessionDoc(); // starts with holdings: 0
        const GridSimulatorSession = makeFakeSessionModel([session]);
        const GridSimulatorTrade = makeFakeTradeModel();
        realtime.init({ GridSimulatorSession, GridSimulatorTrade, io: makeFakeIo() });
        realtime.registerSession(session);

        // Upward crossing of sell level n=1 at 343 with zero holdings.
        realtime.handleUpstreamTick({ instrumentKey: "NSE_EQ|GICRE", ltp: 343, timestamp: Date.now() }, "ws");
        await new Promise((resolve) => setTimeout(resolve, 15));

        let persisted = GridSimulatorSession.docs.get(String(session._id));
        assert.strictEqual(GridSimulatorTrade.docs.length, 1);
        assert.strictEqual(GridSimulatorTrade.docs[0].type, "SELL");
        assert.strictEqual(GridSimulatorTrade.docs[0].qtyFilled, 0);
        assert.strictEqual(GridSimulatorTrade.docs[0].reason, "insufficient_holdings");
        assert.strictEqual(persisted.state.holdings, 0);
        assert.strictEqual(persisted.state.lastPrice, 343, "the active reference/watermark advances even on a skipped trade");

        // Further ticks that fluctuate above 343 without crossing a new
        // level must not create another SELL record.
        for (const ltp of [343.4, 343.1, 343.5]) {
            realtime.handleUpstreamTick({ instrumentKey: "NSE_EQ|GICRE", ltp, timestamp: Date.now() }, "ws");
            // eslint-disable-next-line no-await-in-loop
            await new Promise((resolve) => setTimeout(resolve, 15));
        }
        assert.strictEqual(GridSimulatorTrade.docs.length, 1, "no repeated SELL for the same already-processed crossing");
        realtime.unregisterSession(session._id);
    });

    await test("C. after a skipped SELL rebases the reference, a later genuine crossing in either direction is processed normally (ADR-031)", async () => {
        const session = makeActiveSessionDoc();
        const GridSimulatorSession = makeFakeSessionModel([session]);
        const GridSimulatorTrade = makeFakeTradeModel();
        realtime.init({ GridSimulatorSession, GridSimulatorTrade, io: makeFakeIo() });
        realtime.registerSession(session);

        realtime.handleUpstreamTick({ instrumentKey: "NSE_EQ|GICRE", ltp: 343, timestamp: Date.now() }, "ws"); // skipped SELL @343, rebase -> 343
        await new Promise((resolve) => setTimeout(resolve, 15));
        realtime.handleUpstreamTick({ instrumentKey: "NSE_EQ|GICRE", ltp: 340, timestamp: Date.now() }, "ws"); // down-cross through the rebased reference's next level -> BUY
        await new Promise((resolve) => setTimeout(resolve, 15));
        realtime.handleUpstreamTick({ instrumentKey: "NSE_EQ|GICRE", ltp: 343, timestamp: Date.now() }, "ws"); // up-cross again -> SELL (now has holdings to sell)
        await new Promise((resolve) => setTimeout(resolve, 15));

        assert.strictEqual(GridSimulatorTrade.docs.length, 3);
        assert.deepStrictEqual(GridSimulatorTrade.docs.map((t) => t.type), ["SELL", "BUY", "SELL"]);
        assert.strictEqual(GridSimulatorTrade.docs[0].qtyFilled, 0); // skipped, insufficient holdings
        assert.strictEqual(GridSimulatorTrade.docs[1].qtyFilled, 100);
        assert.strictEqual(GridSimulatorTrade.docs[2].qtyFilled, 100);
        realtime.unregisterSession(session._id);
    });

    await test("E. overlapping/duplicate dispatch of the same tick resolves to exactly one processed outcome", async () => {
        const session = makeActiveSessionDoc();
        const GridSimulatorSession = makeFakeSessionModel([session]);
        const GridSimulatorTrade = makeFakeTradeModel();
        realtime.init({ GridSimulatorSession, GridSimulatorTrade, io: makeFakeIo() });
        realtime.registerSession(session);

        const now = Date.now();
        // Dispatch the identical tick object twice back-to-back, simulating
        // a duplicate emit from an overlapping listener/reconnect replay.
        realtime.handleUpstreamTick({ instrumentKey: "NSE_EQ|GICRE", ltp: 336, timestamp: now }, "ws");
        realtime.handleUpstreamTick({ instrumentKey: "NSE_EQ|GICRE", ltp: 336, timestamp: now }, "ws");
        await new Promise((resolve) => setTimeout(resolve, 20));

        assert.strictEqual(GridSimulatorTrade.docs.length, 1, "the duplicate dispatch must not double-process the same crossing");
        const persisted = GridSimulatorSession.docs.get(String(session._id));
        assert.strictEqual(persisted.state.holdings, 100);
        realtime.unregisterSession(session._id);
    });

    await test("F. a stale/out-of-order tick cannot reverse state, but a legitimate later crossing still works", async () => {
        const session = makeActiveSessionDoc();
        const GridSimulatorSession = makeFakeSessionModel([session]);
        const GridSimulatorTrade = makeFakeTradeModel();
        realtime.init({ GridSimulatorSession, GridSimulatorTrade, io: makeFakeIo() });
        realtime.registerSession(session);

        const t1 = Date.now();
        realtime.handleUpstreamTick({ instrumentKey: "NSE_EQ|GICRE", ltp: 337, timestamp: t1 }, "ws"); // BUY @337
        await new Promise((resolve) => setTimeout(resolve, 15));

        // A stale tick with an EARLIER timestamp than the last processed one
        // arrives late (e.g. reordered on the wire) carrying a price that
        // would otherwise re-arm/reverse the level.
        realtime.handleUpstreamTick({ instrumentKey: "NSE_EQ|GICRE", ltp: 339, timestamp: t1 - 5000 }, "ws");
        await new Promise((resolve) => setTimeout(resolve, 15));

        let persisted = GridSimulatorSession.docs.get(String(session._id));
        assert.strictEqual(GridSimulatorTrade.docs.length, 1, "the stale/out-of-order tick must be rejected, not processed");
        assert.strictEqual(persisted.state.lastPrice, 337, "state must not move backward from a stale tick");

        // A genuine, later-timestamped crossing (down through the next buy
        // level, 334) still works normally.
        realtime.handleUpstreamTick({ instrumentKey: "NSE_EQ|GICRE", ltp: 333, timestamp: Date.now() }, "ws");
        await new Promise((resolve) => setTimeout(resolve, 15));
        persisted = GridSimulatorSession.docs.get(String(session._id));
        assert.strictEqual(persisted.state.holdings, 200, "a legitimate subsequent crossing must still be processed");
        realtime.unregisterSession(session._id);
    });

    await test("H. a processed (including skipped) crossing is not re-executed after a simulated restart/resync", async () => {
        const session = makeActiveSessionDoc();
        const GridSimulatorSession = makeFakeSessionModel([session]);
        const GridSimulatorTrade = makeFakeTradeModel();
        realtime.init({ GridSimulatorSession, GridSimulatorTrade, io: makeFakeIo() });
        realtime.registerSession(session);

        // Skipped SELL (zero holdings) at 343.
        realtime.handleUpstreamTick({ instrumentKey: "NSE_EQ|GICRE", ltp: 343, timestamp: Date.now() }, "ws");
        await new Promise((resolve) => setTimeout(resolve, 15));
        assert.strictEqual(GridSimulatorTrade.docs.length, 1);

        // Simulate a process restart: unregister (as shutdown would leave
        // nothing registered), then resync the in-memory registry purely
        // from the ALREADY-PERSISTED session doc, same as server boot.
        realtime.unregisterSession(session._id);
        const restoredCount = await realtime.resyncFromDb({ GridSimulatorSession });
        assert.strictEqual(restoredCount, 1);

        // Further ticks that fluctuate above 343 (never dipping back below
        // it, so the level is never legitimately re-armed) must still not
        // re-execute the already-processed crossing.
        for (const ltp of [343.2, 343.5, 343.3]) {
            realtime.handleUpstreamTick({ instrumentKey: "NSE_EQ|GICRE", ltp, timestamp: Date.now() }, "ws");
            // eslint-disable-next-line no-await-in-loop
            await new Promise((resolve) => setTimeout(resolve, 15));
        }
        assert.strictEqual(GridSimulatorTrade.docs.length, 1, "the already-processed crossing must not repeat after a restart/resync");
        realtime.unregisterSession(session._id);
    });

    // --- Equity/unrealizedPnL dashboard-discrepancy regression (ADR-029):
    // buildUpdatePayload() previously hand-built `portfolio` with only
    // cash/holdings/avgCost/realizedPnL, omitting equity/unrealizedPnL/
    // marketValue — and the frontend's merge then kept a STALE equity/
    // unrealizedPnL from an earlier push while cash/holdings/avgCost moved
    // on, reproducing the exact reported dashboard discrepancy. Fixed by
    // always recomputing the full portfolio snapshot via the same
    // computePortfolioMetrics() the REST detail route uses. ---

    await test("I. every pushed Socket.IO update carries a fresh, internally-consistent portfolio snapshot (equity/unrealizedPnL match the just-updated cash/holdings/avgCost)", async () => {
        const session = makeActiveSessionDoc();
        const GridSimulatorSession = makeFakeSessionModel([session]);
        const GridSimulatorTrade = makeFakeTradeModel();
        const io = makeFakeIo();
        realtime.init({ GridSimulatorSession, GridSimulatorTrade, io });
        realtime.registerSession(session);

        // BUY @337 (down-cross from reference 340).
        realtime.handleUpstreamTick({ instrumentKey: "NSE_EQ|GICRE", ltp: 337, timestamp: Date.now() }, "ws");
        await new Promise((resolve) => setTimeout(resolve, 20));

        let pushed = io.emitted.filter((e) => e.event === "gridSimulatorUpdate").pop().payload;
        assert.strictEqual(pushed.portfolio.holdings, 100);
        assert.strictEqual(pushed.portfolio.cash, 1000000 - 100 * 337);
        // Equity/unrealizedPnL must be computed from the SAME snapshot, not
        // stale/omitted.
        assert.strictEqual(pushed.portfolio.equity, pushed.portfolio.cash + 100 * 337);
        assert.strictEqual(pushed.portfolio.unrealizedPnL, 0); // bought at 337, valued at 337

        // A further genuine price move (no new crossing) still re-prices
        // equity/unrealizedPnL against the latest price on every push.
        realtime.handleUpstreamTick({ instrumentKey: "NSE_EQ|GICRE", ltp: 338, timestamp: Date.now() }, "ws");
        await new Promise((resolve) => setTimeout(resolve, 20));

        pushed = io.emitted.filter((e) => e.event === "gridSimulatorUpdate").pop().payload;
        assert.strictEqual(pushed.portfolio.holdings, 100, "holdings unchanged (no new crossing)");
        assert.strictEqual(pushed.portfolio.unrealizedPnL, 100 * (338 - 337), "unrealizedPnL repriced against the latest price, not stale");
        assert.strictEqual(pushed.portfolio.equity, pushed.portfolio.cash + 100 * 338);
        realtime.unregisterSession(session._id);
    });

    // --- Feed-status locking review (ADR-030): evaluated applying the
    // processTick() claim lock to the REST-fallback branch's display-only
    // write too, to close a theoretical badge-flicker race (a REST
    // fallback event and a genuine WS tick landing for the same session at
    // nearly the same instant could have their lastFeedStatus/lastFeedPrice
    // writes apply out of order). Decided NOT to change it: the lock is
    // held for up to LOCK_DURATION_MS (30s) until explicitly released, and
    // wrapping a simple cosmetic field update in acquire/release logic
    // risks a bug (an early return or exception before release) blocking
    // genuine WS trade processing for up to 30 seconds — a far worse
    // outcome than the flicker it would fix, directly violating "must not
    // block genuine WebSocket trade processing." This test proves the
    // actual, bounded blast radius of the race left as-is: it can only
    // ever affect the cosmetic lastFeedStatus/lastFeedPrice fields, never
    // cash/holdings/avgCost/realizedPnL or the trade ledger — those are
    // only ever written by the locked processTick() path. ---

    await test("J. a REST fallback event racing a genuine WS trade cannot corrupt cash/holdings/trades — only the cosmetic feed-status fields are at risk", async () => {
        const session = makeActiveSessionDoc();
        const GridSimulatorSession = makeFakeSessionModel([session]);
        const GridSimulatorTrade = makeFakeTradeModel();
        const io = makeFakeIo();
        realtime.init({ GridSimulatorSession, GridSimulatorTrade, io });
        realtime.registerSession(session);

        // Dispatch a genuine WS trade-triggering tick and a REST fallback
        // tick for the SAME session back-to-back (worst-case ordering is
        // not controllable since both are fire-and-forget, but either
        // order must leave the authoritative state correct).
        realtime.handleUpstreamTick({ instrumentKey: "NSE_EQ|GICRE", ltp: 337, timestamp: Date.now() }, "ws"); // BUY
        realtime.handleUpstreamTick({ instrumentKey: "NSE_EQ|GICRE", ltp: 500, timestamp: Date.now() }, "rest"); // fallback, would be a huge fake gap if authoritative
        await new Promise((resolve) => setTimeout(resolve, 25));

        const persisted = GridSimulatorSession.docs.get(String(session._id));
        // The authoritative state reflects ONLY the genuine WS trade — the
        // REST fallback price never reached the crossing engine regardless
        // of dispatch order.
        assert.strictEqual(persisted.state.holdings, 100);
        assert.strictEqual(persisted.state.lastPrice, 337);
        assert.strictEqual(GridSimulatorTrade.docs.length, 1);
        assert.strictEqual(GridSimulatorTrade.docs[0].fillPrice, 337);
        // Only the feed-status/price display fields are left to whichever
        // write landed last — by design, not a defect in this review.
        assert.ok(["LIVE", "LIVE_REST_FALLBACK"].includes(persisted.lastFeedStatus));
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
