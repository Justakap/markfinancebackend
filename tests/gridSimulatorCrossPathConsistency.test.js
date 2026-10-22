/**
 * Grid Trading Simulator — cross-path consistency integration test
 * (independent review follow-up). Drives a real sequence of events
 * through the REAL gridSimulatorService + gridSimulatorRealtime modules
 * against one shared in-memory fake store, then verifies the REST
 * detail payload (routes/gridSimulatorRoutes.js's sessionDetail/
 * getPortfolioMetrics) and the LAST Socket.IO push payload
 * (gridSimulatorRealtime.js's buildUpdatePayload) report IDENTICAL
 * portfolio figures for the same underlying session — not just that
 * each one individually looks plausible in isolation.
 */
const assert = require("assert");
const mongoose = require("mongoose");

process.env.UPSTOX_INSTRUMENT_MASTER_URL = "https://fake.test/grid-cross-path-instruments.json";
delete process.env.UPSTOX_ACCESS_TOKEN;
delete process.env.UPSTOX_TOKEN;

const marketDataService = require("../services/marketDataService");
marketDataService.primeInstrumentsCacheForTests([]);

const { createSession, startSessionWithInitialBuy, getOwnedSession, getPortfolioMetrics } = require("../services/gridSimulatorService");
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

function matchFilter(doc, filter = {}) {
    return Object.entries(filter).every(([key, cond]) => {
        if (key === "$or") return cond.some((sub) => matchFilter(doc, sub));
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

function makeFakeSessionModel() {
    const docs = new Map();
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

function makeFakeIo() {
    const emitted = [];
    return {
        emitted,
        to() {
            return { emit: (event, payload) => emitted.push({ event, payload }) };
        },
    };
}

const CONFIG = {
    gridInterval: 3,
    quantityPerLevel: 100,
    startingCapital: 1000000,
    maxPositionSize: null,
    commissionPct: 0,
    slippagePct: 0,
};

// ADR-038: the reference is no longer part of config — it's captured and
// passed explicitly to startSessionWithInitialBuy() at Start.
const REFERENCE_PRICE = 340;
const REFERENCE_CAPTURED_AT = new Date(2026, 0, 1, 9, 15);

(async () => {
    console.log("Grid Trading Simulator — cross-path (REST vs Socket.IO) consistency\n");

    await test("REST detail and the last Socket.IO push report identical portfolio figures after a real BUY", async () => {
        const GridSimulatorSession = makeFakeSessionModel();
        const GridSimulatorTrade = makeFakeTradeModel();
        const io = makeFakeIo();
        const userId = new mongoose.Types.ObjectId();

        const session = await createSession({ GridSimulatorSession, userId, instrumentKey: "NSE_EQ|GICRE", symbol: "GICRE", config: CONFIG });
        // ADR-038: Start itself immediately buys 100 @ the captured reference (340).
        await startSessionWithInitialBuy({ GridSimulatorSession, GridSimulatorTrade, sessionId: session._id, userId, referencePrice: REFERENCE_PRICE, referenceCapturedAt: REFERENCE_CAPTURED_AT });

        realtime.init({ GridSimulatorSession, GridSimulatorTrade, io });
        realtime.registerSession({ _id: session._id, instrumentKey: "NSE_EQ|GICRE" });

        // Genuine WS ticks: down-cross through 337 (a second BUY, on top of
        // Start's own), then a non-crossing move so equity/unrealizedPnL get
        // re-priced without a new trade.
        realtime.handleUpstreamTick({ instrumentKey: "NSE_EQ|GICRE", ltp: 336, timestamp: Date.now() }, "ws");
        await new Promise((resolve) => setTimeout(resolve, 20));
        realtime.handleUpstreamTick({ instrumentKey: "NSE_EQ|GICRE", ltp: 336.5, timestamp: Date.now() }, "ws");
        await new Promise((resolve) => setTimeout(resolve, 20));

        const lastPush = io.emitted.filter((e) => e.event === "gridSimulatorUpdate").pop().payload;

        const restSession = await getOwnedSession({ GridSimulatorSession, sessionId: session._id, userId });
        const restPortfolio = getPortfolioMetrics(restSession, restSession.lastFeedPrice ?? restSession.state.lastPrice);

        assert.deepStrictEqual(lastPush.portfolio, restPortfolio, "REST and Socket.IO must agree exactly on cash/holdings/avgCost/equity/unrealizedPnL/marketValue/realizedPnL");
        assert.strictEqual(restPortfolio.holdings, 200); // Start's 100 @ 340 + the crossing's 100 @ 336
        assert.strictEqual(restPortfolio.equity, restPortfolio.cash + 200 * 336.5);

        // Trade ledger agrees with the two real fills that occurred (Start's own + the crossing).
        assert.strictEqual(GridSimulatorTrade.docs.length, 2);
        assert.strictEqual(GridSimulatorTrade.docs[0].type, "BUY");
        assert.strictEqual(GridSimulatorTrade.docs[0].qtyFilled, 100);
        assert.strictEqual(GridSimulatorTrade.docs[0].fillPrice, 340);
        assert.strictEqual(GridSimulatorTrade.docs[1].type, "BUY");
        assert.strictEqual(GridSimulatorTrade.docs[1].qtyFilled, 100);
        assert.strictEqual(GridSimulatorTrade.docs[1].fillPrice, 336);

        realtime.unregisterSession(session._id);
    });

    await test("REST detail and Socket.IO push still agree after a skipped SELL (insufficient holdings)", async () => {
        // ADR-038: Start's own immediate BUY (100 @ 340) arms one pending
        // sell at 343. A single gap tick straight to 350 cascades through
        // 343 (fully filled from the 100 held), then 346 and 349 (both
        // genuinely skipped — zero holdings left) — a naturally-reached
        // full skip (qtyFilled 0, reason insufficient_holdings), all within
        // one event.
        const GridSimulatorSession = makeFakeSessionModel();
        const GridSimulatorTrade = makeFakeTradeModel();
        const io = makeFakeIo();
        const userId = new mongoose.Types.ObjectId();

        const session = await createSession({ GridSimulatorSession, userId, instrumentKey: "NSE_EQ|GICRE", symbol: "GICRE", config: CONFIG });
        await startSessionWithInitialBuy({ GridSimulatorSession, GridSimulatorTrade, sessionId: session._id, userId, referencePrice: REFERENCE_PRICE, referenceCapturedAt: REFERENCE_CAPTURED_AT });

        realtime.init({ GridSimulatorSession, GridSimulatorTrade, io });
        realtime.registerSession({ _id: session._id, instrumentKey: "NSE_EQ|GICRE" });

        realtime.handleUpstreamTick({ instrumentKey: "NSE_EQ|GICRE", ltp: 350, timestamp: Date.now() }, "ws");
        await new Promise((resolve) => setTimeout(resolve, 20));

        const lastPush = io.emitted.filter((e) => e.event === "gridSimulatorUpdate").pop().payload;
        const restSession = await getOwnedSession({ GridSimulatorSession, sessionId: session._id, userId });
        const restPortfolio = getPortfolioMetrics(restSession, restSession.lastFeedPrice ?? restSession.state.lastPrice);

        assert.deepStrictEqual(lastPush.portfolio, restPortfolio);
        assert.strictEqual(restPortfolio.holdings, 0);
        assert.strictEqual(restPortfolio.unrealizedPnL, 0);
        assert.strictEqual(restPortfolio.equity, restPortfolio.cash);
        assert.strictEqual(GridSimulatorTrade.docs.length, 4); // Start's BUY + 1 filled SELL + 2 skipped SELLs
        assert.strictEqual(GridSimulatorTrade.docs[1].qtyFilled, 100);
        assert.strictEqual(GridSimulatorTrade.docs[2].qtyFilled, 0);
        assert.strictEqual(GridSimulatorTrade.docs[2].reason, "insufficient_holdings");
        assert.strictEqual(GridSimulatorTrade.docs[3].qtyFilled, 0);
        assert.strictEqual(GridSimulatorTrade.docs[3].reason, "insufficient_holdings");

        realtime.unregisterSession(session._id);
    });

    await test("ADR-037/ADR-038: REST and Socket.IO agree on the nearest pending buy/sell levels after the user's reported 320->329->317 scenario", async () => {
        const GridSimulatorSession = makeFakeSessionModel();
        const GridSimulatorTrade = makeFakeTradeModel();
        const io = makeFakeIo();
        const userId = new mongoose.Types.ObjectId();

        const session = await createSession({ GridSimulatorSession, userId, instrumentKey: "NSE_EQ|GICRE", symbol: "GICRE", config: CONFIG });
        // ADR-038: Start itself immediately buys 100 @ 320, arming a pending
        // sell at 323 alongside the seeded pending buy at 317.
        await startSessionWithInitialBuy({ GridSimulatorSession, GridSimulatorTrade, sessionId: session._id, userId, referencePrice: 320, referenceCapturedAt: REFERENCE_CAPTURED_AT });

        realtime.init({ GridSimulatorSession, GridSimulatorTrade, io });
        realtime.registerSession({ _id: session._id, instrumentKey: "NSE_EQ|GICRE" });

        // Up to 329 cascades through the armed sell ladder (323, 326, 329),
        // filling the first (the only 100 held) and skipping the rest (zero
        // holdings left). Down to 317 then cascades through every pending
        // buy level now in range (317, 320, 323, 326), each filling fully.
        realtime.handleUpstreamTick({ instrumentKey: "NSE_EQ|GICRE", ltp: 329, timestamp: Date.now() }, "ws");
        await new Promise((resolve) => setTimeout(resolve, 20));
        realtime.handleUpstreamTick({ instrumentKey: "NSE_EQ|GICRE", ltp: 317, timestamp: Date.now() }, "ws");
        await new Promise((resolve) => setTimeout(resolve, 20));

        const lastPush = io.emitted.filter((e) => e.event === "gridSimulatorUpdate").pop().payload;
        const restSession = await getOwnedSession({ GridSimulatorSession, sessionId: session._id, userId });

        assert.strictEqual(restSession.state.holdings, 400);
        assert.deepStrictEqual(restSession.state.pendingSellLevels, [332, 329, 326, 323, 320]);
        assert.deepStrictEqual(restSession.state.pendingBuyLevels, [314]);
        assert.strictEqual(lastPush.state.nextSellLevel, 320);
        assert.strictEqual(lastPush.state.nextBuyLevel, 314);

        const trades = GridSimulatorTrade.docs;
        assert.strictEqual(trades.length, 8); // Start's BUY, 1 filled + 2 skipped SELL, 4 filled BUY
        assert.strictEqual(trades[0].type, "BUY");
        assert.strictEqual(trades[0].fillPrice, 320);
        assert.strictEqual(trades[1].type, "SELL");
        assert.strictEqual(trades[1].qtyFilled, 100);
        assert.strictEqual(trades[2].qtyFilled, 0);
        assert.strictEqual(trades[3].qtyFilled, 0);
        trades.slice(4).forEach((trade) => {
            assert.strictEqual(trade.type, "BUY");
            assert.strictEqual(trade.qtyFilled, 100);
            assert.strictEqual(trade.fillPrice, 317);
        });

        realtime.unregisterSession(session._id);
    });

    console.log(`\nGrid simulator cross-path consistency tests: ${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
