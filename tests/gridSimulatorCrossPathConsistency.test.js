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

const { createSession, startSession, getOwnedSession, getPortfolioMetrics } = require("../services/gridSimulatorService");
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
    referencePrice: 340,
    referenceCapturedAt: new Date(2026, 0, 1, 9, 15).toISOString(),
    gridInterval: 3,
    quantityPerLevel: 100,
    startingCapital: 1000000,
    maxPositionSize: null,
    commissionPct: 0,
    slippagePct: 0,
};

(async () => {
    console.log("Grid Trading Simulator — cross-path (REST vs Socket.IO) consistency\n");

    await test("REST detail and the last Socket.IO push report identical portfolio figures after a real BUY", async () => {
        const GridSimulatorSession = makeFakeSessionModel();
        const GridSimulatorTrade = makeFakeTradeModel();
        const io = makeFakeIo();
        const userId = new mongoose.Types.ObjectId();

        const session = await createSession({ GridSimulatorSession, userId, instrumentKey: "NSE_EQ|GICRE", symbol: "GICRE", config: CONFIG });
        await startSession({ GridSimulatorSession, sessionId: session._id, userId });

        realtime.init({ GridSimulatorSession, GridSimulatorTrade, io });
        realtime.registerSession({ _id: session._id, instrumentKey: "NSE_EQ|GICRE" });

        // Genuine WS ticks: down-cross through 337 (BUY), then a non-crossing
        // move so equity/unrealizedPnL get re-priced without a new trade.
        realtime.handleUpstreamTick({ instrumentKey: "NSE_EQ|GICRE", ltp: 336, timestamp: Date.now() }, "ws");
        await new Promise((resolve) => setTimeout(resolve, 20));
        realtime.handleUpstreamTick({ instrumentKey: "NSE_EQ|GICRE", ltp: 336.5, timestamp: Date.now() }, "ws");
        await new Promise((resolve) => setTimeout(resolve, 20));

        const lastPush = io.emitted.filter((e) => e.event === "gridSimulatorUpdate").pop().payload;

        const restSession = await getOwnedSession({ GridSimulatorSession, sessionId: session._id, userId });
        const restPortfolio = getPortfolioMetrics(restSession, restSession.lastFeedPrice ?? restSession.state.lastPrice);

        assert.deepStrictEqual(lastPush.portfolio, restPortfolio, "REST and Socket.IO must agree exactly on cash/holdings/avgCost/equity/unrealizedPnL/marketValue/realizedPnL");
        assert.strictEqual(restPortfolio.holdings, 100);
        assert.strictEqual(restPortfolio.equity, restPortfolio.cash + 100 * 336.5);

        // Trade ledger agrees with the one real fill that occurred.
        assert.strictEqual(GridSimulatorTrade.docs.length, 1);
        assert.strictEqual(GridSimulatorTrade.docs[0].type, "BUY");
        assert.strictEqual(GridSimulatorTrade.docs[0].qtyFilled, 100);

        realtime.unregisterSession(session._id);
    });

    await test("REST detail and Socket.IO push still agree after a skipped SELL (insufficient holdings)", async () => {
        const GridSimulatorSession = makeFakeSessionModel();
        const GridSimulatorTrade = makeFakeTradeModel();
        const io = makeFakeIo();
        const userId = new mongoose.Types.ObjectId();

        const session = await createSession({ GridSimulatorSession, userId, instrumentKey: "NSE_EQ|GICRE", symbol: "GICRE", config: CONFIG });
        await startSession({ GridSimulatorSession, sessionId: session._id, userId });

        realtime.init({ GridSimulatorSession, GridSimulatorTrade, io });
        realtime.registerSession({ _id: session._id, instrumentKey: "NSE_EQ|GICRE" });

        realtime.handleUpstreamTick({ instrumentKey: "NSE_EQ|GICRE", ltp: 343, timestamp: Date.now() }, "ws"); // skipped SELL, zero holdings
        await new Promise((resolve) => setTimeout(resolve, 20));

        const lastPush = io.emitted.filter((e) => e.event === "gridSimulatorUpdate").pop().payload;
        const restSession = await getOwnedSession({ GridSimulatorSession, sessionId: session._id, userId });
        const restPortfolio = getPortfolioMetrics(restSession, restSession.lastFeedPrice ?? restSession.state.lastPrice);

        assert.deepStrictEqual(lastPush.portfolio, restPortfolio);
        assert.strictEqual(restPortfolio.holdings, 0);
        assert.strictEqual(restPortfolio.unrealizedPnL, 0);
        assert.strictEqual(restPortfolio.equity, restPortfolio.cash);
        assert.strictEqual(GridSimulatorTrade.docs.length, 1);
        assert.strictEqual(GridSimulatorTrade.docs[0].qtyFilled, 0);
        assert.strictEqual(GridSimulatorTrade.docs[0].reason, "insufficient_holdings");

        realtime.unregisterSession(session._id);
    });

    console.log(`\nGrid simulator cross-path consistency tests: ${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
