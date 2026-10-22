/**
 * Grid Trading Simulator — tests for services/gridSimulatorService.js using
 * in-memory fake Mongoose-like models (same convention as
 * liveStrategyOrchestrator.test.js: findOneAndUpdate implements the same
 * single-operation atomicity a real MongoDB server provides — no `await`
 * between the match check and the write — so the concurrency tests below
 * genuinely prove the claim-lock logic, not just assume it).
 */
const assert = require("assert");
const mongoose = require("mongoose");

const {
    createSession,
    getOwnedSession,
    startSessionWithInitialBuy,
    pauseSession,
    resumeSession,
    stopSession,
    processTick,
    listTrades,
    getTradeCounts,
    getChargesSummary,
    updateSessionConfig,
    deleteSession,
} = require("../services/gridSimulatorService");

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

// ADR-038: the reference is no longer part of the create-time config — it's
// captured at Start. These two constants stand in for "the fresh live quote
// captureFreshReference() would have fetched," passed explicitly to
// startSessionWithInitialBuy() by every test that needs an ACTIVE session.
const REFERENCE_PRICE = 340;
const REFERENCE_CAPTURED_AT = new Date(2026, 0, 1, 9, 0); // strictly before this file's various first-tick timestamps (9:15+)

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
        if (key === "$in") return true;
        if (cond !== null && typeof cond === "object" && !(cond instanceof Date) && !(cond instanceof mongoose.Types.ObjectId)) {
            if ("$lte" in cond) return doc[key] != null && new Date(doc[key]).getTime() <= new Date(cond.$lte).getTime();
            if ("$in" in cond) return cond.$in.includes(doc[key]);
            if ("$gt" in cond) return Number(doc[key]) > Number(cond.$gt);
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

function applyInc(doc, incOps = {}) {
    Object.entries(incOps).forEach(([path, delta]) => {
        const parts = path.split(".");
        let target = doc;
        for (let i = 0; i < parts.length - 1; i += 1) {
            target[parts[i]] = target[parts[i]] || {};
            target = target[parts[i]];
        }
        const last = parts[parts.length - 1];
        target[last] = (target[last] || 0) + delta;
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
        // Atomic: no `await` between match and write.
        async findOneAndUpdate(filter, update, options = {}) {
            const found = [...docs.values()].find((doc) => matchFilter(doc, filter));
            if (!found) return null;
            if (update.$set) applySet(found, update.$set);
            if (update.$inc) applyInc(found, update.$inc);
            return options.new ? JSON.parse(JSON.stringify(found)) : null;
        },
        find(filter = {}) {
            return makeQuery([...docs.values()].filter((doc) => matchFilter(doc, filter)));
        },
        async countDocuments(filter = {}) {
            return [...docs.values()].filter((doc) => matchFilter(doc, filter)).length;
        },
        async deleteOne(filter = {}) {
            const found = [...docs.values()].find((doc) => matchFilter(doc, filter));
            if (found) docs.delete(String(found._id));
            return { deletedCount: found ? 1 : 0 };
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
            return makeQuery(docs.filter((doc) => matchFilter(doc, filter)));
        },
        async countDocuments(filter = {}) {
            return docs.filter((doc) => matchFilter(doc, filter)).length;
        },
        async deleteMany(filter = {}) {
            const toRemove = docs.filter((doc) => matchFilter(doc, filter));
            toRemove.forEach((doc) => {
                const idx = docs.indexOf(doc);
                if (idx !== -1) docs.splice(idx, 1);
            });
            return { deletedCount: toRemove.length };
        },
    };
}

// ADR-038: Start now ALWAYS executes one immediate BUY at the captured
// reference price — so a freshly-"active" session already has
// quantityPerLevel (100) shares (cost 340), not a flat 0-holdings start.
// Every test using this helper accounts for that initial fill.
async function makeActiveSession(userId = new mongoose.Types.ObjectId(), { referencePrice = REFERENCE_PRICE, referenceCapturedAt = REFERENCE_CAPTURED_AT } = {}) {
    const GridSimulatorSession = makeFakeSessionModel();
    const GridSimulatorTrade = makeFakeTradeModel();
    const created = await createSession({ GridSimulatorSession, userId, instrumentKey: "NSE_EQ|TEST", symbol: "TEST", config: CONFIG });
    const session = await startSessionWithInitialBuy({ GridSimulatorSession, GridSimulatorTrade, sessionId: created._id, userId, referencePrice, referenceCapturedAt });
    return { GridSimulatorSession, GridSimulatorTrade, session, userId };
}

(async () => {
    // --- validation / creation ---

        await test("createSession rejects an invalid grid configuration with a 400", async () => {
        const GridSimulatorSession = makeFakeSessionModel();
        await assert.rejects(
            () => createSession({ GridSimulatorSession, userId: new mongoose.Types.ObjectId(), instrumentKey: "X", symbol: "X", config: { ...CONFIG, gridInterval: -1 } }),
            (err) => err.statusCode === 400,
        );
    });

        await test("createSession rejects a duplicate active/paused session for the same user+instrument", async () => {
        const GridSimulatorSession = makeFakeSessionModel();
        const userId = new mongoose.Types.ObjectId();
        await createSession({ GridSimulatorSession, userId, instrumentKey: "NSE_EQ|DUP", symbol: "DUP", config: CONFIG });
        await assert.rejects(
            () => createSession({ GridSimulatorSession, userId, instrumentKey: "NSE_EQ|DUP", symbol: "DUP", config: CONFIG }),
            (err) => err.statusCode === 409,
        );
    });

        await test("ownership isolation: getOwnedSession 404s for a different user", async () => {
        const GridSimulatorSession = makeFakeSessionModel();
        const owner = new mongoose.Types.ObjectId();
        const other = new mongoose.Types.ObjectId();
        const session = await createSession({ GridSimulatorSession, userId: owner, instrumentKey: "NSE_EQ|OWN", symbol: "OWN", config: CONFIG });
        await assert.rejects(
            () => getOwnedSession({ GridSimulatorSession, sessionId: session._id, userId: other }),
            (err) => err.statusCode === 404,
        );
    });

    // --- lifecycle transitions ---

        await test("session lifecycle: CREATED -> ACTIVE -> PAUSED -> ACTIVE -> STOPPED", async () => {
        const GridSimulatorSession = makeFakeSessionModel();
        const GridSimulatorTrade = makeFakeTradeModel();
        const userId = new mongoose.Types.ObjectId();
        const session = await createSession({ GridSimulatorSession, userId, instrumentKey: "NSE_EQ|LC", symbol: "LC", config: CONFIG });
        assert.strictEqual(session.status, "CREATED");
        assert.strictEqual(session.config.referencePrice, null, "no reference yet before Start (ADR-038)");

        const started = await startSessionWithInitialBuy({ GridSimulatorSession, GridSimulatorTrade, sessionId: session._id, userId, referencePrice: REFERENCE_PRICE, referenceCapturedAt: REFERENCE_CAPTURED_AT });
        assert.strictEqual(started.status, "ACTIVE");
        assert.strictEqual(started.config.referencePrice, REFERENCE_PRICE);
        assert.strictEqual(started.state.holdings, 100, "Start immediately buys at the reference price");

        const paused = await pauseSession({ GridSimulatorSession, sessionId: session._id, userId });
        assert.strictEqual(paused.status, "PAUSED");

        const resumed = await resumeSession({ GridSimulatorSession, sessionId: session._id, userId });
        assert.strictEqual(resumed.status, "ACTIVE");
        assert.strictEqual(resumed.state.holdings, 100, "Resume never re-buys");

        const stopped = await stopSession({ GridSimulatorSession, sessionId: session._id, userId });
        assert.strictEqual(stopped.status, "STOPPED");
    });

        await test("invalid transitions are rejected with 409 (e.g. starting an already-stopped session)", async () => {
        const GridSimulatorSession = makeFakeSessionModel();
        const GridSimulatorTrade = makeFakeTradeModel();
        const userId = new mongoose.Types.ObjectId();
        const session = await createSession({ GridSimulatorSession, userId, instrumentKey: "NSE_EQ|INV", symbol: "INV", config: CONFIG });
        await startSessionWithInitialBuy({ GridSimulatorSession, GridSimulatorTrade, sessionId: session._id, userId, referencePrice: REFERENCE_PRICE, referenceCapturedAt: REFERENCE_CAPTURED_AT });
        await stopSession({ GridSimulatorSession, sessionId: session._id, userId });
        await assert.rejects(
            () => startSessionWithInitialBuy({ GridSimulatorSession, GridSimulatorTrade, sessionId: session._id, userId, referencePrice: REFERENCE_PRICE, referenceCapturedAt: REFERENCE_CAPTURED_AT }),
            (err) => err.statusCode === 409,
        );
    });

    // --- tick processing / idempotency / restart recovery ---

        await test("processTick only runs against an ACTIVE session", async () => {
        const GridSimulatorSession = makeFakeSessionModel();
        const GridSimulatorTrade = makeFakeTradeModel();
        const userId = new mongoose.Types.ObjectId();
        const session = await createSession({ GridSimulatorSession, userId, instrumentKey: "NSE_EQ|NA", symbol: "NA", config: CONFIG });
        const result = await processTick({ GridSimulatorSession, GridSimulatorTrade, sessionId: session._id, price: 336, eventTimestamp: new Date().toISOString() });
        assert.strictEqual(result.skipped, true);
        assert.strictEqual(result.reason, "locked-or-inactive");
    });

        await test("processTick produces a fill and persists both state and a ledger row", async () => {
        const { GridSimulatorSession, GridSimulatorTrade, session } = await makeActiveSession();
        assert.strictEqual(session.state.holdings, 100, "sanity check: Start already bought 100 @ 340");
        const result = await processTick({ GridSimulatorSession, GridSimulatorTrade, sessionId: session._id, price: 336, eventTimestamp: new Date(2026, 0, 1, 9, 15).toISOString() });
        assert.strictEqual(result.trades.length, 1);
        assert.strictEqual(result.trades[0].qtyFilled, 100);

        const persisted = await GridSimulatorSession.findOne({ _id: session._id });
        assert.strictEqual(persisted.state.holdings, 200); // 100 from Start + 100 from this tick
        assert.strictEqual(persisted.processingLockedUntil, null); // lock released

        const ledgerRows = await listTrades({ GridSimulatorTrade, sessionId: session._id, page: 1, limit: 10 });
        assert.strictEqual(ledgerRows.total, 2); // the initial Start buy + this tick's buy
        const thisTick = ledgerRows.items.find((t) => t.fillPrice === 336);
        assert.strictEqual(thisTick.cashAfter, 1000000 - 100 * REFERENCE_PRICE - 100 * 336);
    });

    await test("getTradeCounts reports buy/sell/skipped/partial counts across the WHOLE ledger, not just one page", async () => {
        const { GridSimulatorSession, GridSimulatorTrade, session } = await makeActiveSession(); // Start itself is 1 BUY (100 @ 340)

        await processTick({ GridSimulatorSession, GridSimulatorTrade, sessionId: session._id, price: 336, eventTimestamp: new Date(2026, 0, 1, 9, 15).toISOString() }); // BUY filled (200 held)
        await processTick({ GridSimulatorSession, GridSimulatorTrade, sessionId: session._id, price: 345, eventTimestamp: new Date(2026, 0, 1, 9, 16).toISOString() }); // both armed SELLs fill fully (200 held covers both)
        await processTick({ GridSimulatorSession, GridSimulatorTrade, sessionId: session._id, price: 340, eventTimestamp: new Date(2026, 0, 1, 9, 17).toISOString() }); // BUY filled

        const counts = await getTradeCounts({ GridSimulatorTrade, sessionId: session._id });
        assert.deepStrictEqual(counts, { buyCount: 3, sellCount: 2, skippedCount: 0, partialCount: 0 });
    });

        await test("getChargesSummary (ADR-035) aggregates the display-only charges estimate across the whole ledger, keyed by the session's own segmentClass", async () => {
        const { GridSimulatorSession, GridSimulatorTrade, session } = await makeActiveSession();
        await processTick({ GridSimulatorSession, GridSimulatorTrade, sessionId: session._id, price: 336, eventTimestamp: new Date(2026, 0, 1, 9, 15).toISOString() }); // BUY filled

        const charges = await getChargesSummary({ GridSimulatorTrade, sessionId: session._id, segmentClass: "EQUITY_DELIVERY" });
        assert.strictEqual(charges.segmentClass, "EQUITY_DELIVERY");
        assert.strictEqual(charges.approximate, false);
        assert.strictEqual(charges.brokerage, 0, "equity delivery brokerage is zero");
        assert.ok(charges.total > 0, "a real filled BUY incurs some real charge (STT/exchange/SEBI/stamp duty)");
    });

    await test("trade ledger sequence numbers never collide across a multi-trade gap event followed by a later event", async () => {
        const { GridSimulatorSession, GridSimulatorTrade, session } = await makeActiveSession(); // Start = 1 ledger row already
        // Gap from 340 straight to 310 crosses 10 levels in one event.
        const gapResult = await processTick({ GridSimulatorSession, GridSimulatorTrade, sessionId: session._id, price: 310, eventTimestamp: new Date(2026, 0, 1, 9, 15).toISOString() });
        assert.strictEqual(gapResult.trades.length, 10);

        // A later, separate single-trade event (price falls further, crosses the next buy level below 310).
        await processTick({ GridSimulatorSession, GridSimulatorTrade, sessionId: session._id, price: 307, eventTimestamp: new Date(2026, 0, 1, 9, 16).toISOString() });

        const ledgerRows = await listTrades({ GridSimulatorTrade, sessionId: session._id, page: 1, limit: 50 });
        assert.strictEqual(ledgerRows.total, 12); // 1 (Start) + 10 (gap) + 1 (later event)
        const sequences = ledgerRows.items.map((t) => t.sequence);
        const uniqueSequences = new Set(sequences);
        assert.strictEqual(uniqueSequences.size, sequences.length, `sequence numbers must never collide: ${sequences.join(",")}`);
        // The later event's trade must sort strictly after every trade from the gap event.
        assert.strictEqual(Math.max(...sequences), 12);
    });

    await test("a repeated identical/stale tick never duplicates a fill (idempotent restart recovery)", async () => {
        const { GridSimulatorSession, GridSimulatorTrade, session } = await makeActiveSession();
        const ts = new Date(2026, 0, 1, 9, 16).toISOString(); // strictly after CONFIG.referenceCapturedAt (9:15)
        await processTick({ GridSimulatorSession, GridSimulatorTrade, sessionId: session._id, price: 336, eventTimestamp: ts });

        // Simulate a process restart re-delivering the exact same event.
        const replay = await processTick({ GridSimulatorSession, GridSimulatorTrade, sessionId: session._id, price: 336, eventTimestamp: ts });
        assert.strictEqual(replay.skipped, true);
        assert.strictEqual(replay.reason, "duplicate_or_out_of_order_event");

        const persisted = await GridSimulatorSession.findOne({ _id: session._id });
        assert.strictEqual(persisted.state.holdings, 200); // 100 (Start) + 100 (this tick) — unchanged by the replay, not 300

        const ledgerRows = await listTrades({ GridSimulatorTrade, sessionId: session._id, page: 1, limit: 10 });
        assert.strictEqual(ledgerRows.total, 2); // Start + this tick — no duplicate ledger row from the replay
    });

        await test("concurrency: two simultaneous ticks against the same session resolve to exactly one winner", async () => {
        const { GridSimulatorSession, GridSimulatorTrade, session } = await makeActiveSession();
        const [a, b] = await Promise.all([
            processTick({ GridSimulatorSession, GridSimulatorTrade, sessionId: session._id, price: 336, eventTimestamp: new Date(2026, 0, 1, 9, 16, 0).toISOString() }),
            processTick({ GridSimulatorSession, GridSimulatorTrade, sessionId: session._id, price: 330, eventTimestamp: new Date(2026, 0, 1, 9, 16, 1).toISOString() }),
        ]);
        const results = [a, b];
        const winners = results.filter((r) => !r.skipped);
        const losers = results.filter((r) => r.skipped && r.reason === "locked-or-inactive");
        assert.strictEqual(winners.length, 1);
        assert.strictEqual(losers.length, 1);
    });

    await test("createSession with starting inventory persists the user-provided cost basis and holdings", async () => {
        const GridSimulatorSession = makeFakeSessionModel();
        const userId = new mongoose.Types.ObjectId();
        const session = await createSession({
            GridSimulatorSession,
            userId,
            instrumentKey: "NSE_EQ|INV",
            symbol: "INV",
            config: { ...CONFIG, startingHoldings: 200, startingAvgCost: 315 },
        });
        assert.strictEqual(session.state.holdings, 200);
        assert.strictEqual(session.state.avgCost, 315);
        assert.strictEqual(session.config.startingHoldings, 200);
        assert.strictEqual(session.config.startingAvgCost, 315);
    });

    await test("createSession with zero starting holdings never requires or fabricates an average cost", async () => {
        const GridSimulatorSession = makeFakeSessionModel();
        const userId = new mongoose.Types.ObjectId();
        const session = await createSession({
            GridSimulatorSession,
            userId,
            instrumentKey: "NSE_EQ|FLAT",
            symbol: "FLAT",
            config: CONFIG,
        });
        assert.strictEqual(session.state.holdings, 0);
        assert.strictEqual(session.state.avgCost, 0);
    });

    await test("ADR-038: creation has no reference/crossing watermark at all — both are null until Start", async () => {
        const GridSimulatorSession = makeFakeSessionModel();
        const userId = new mongoose.Types.ObjectId();
        const session = await createSession({
            GridSimulatorSession,
            userId,
            instrumentKey: "NSE_EQ|WM",
            symbol: "WM",
            config: CONFIG,
        });
        assert.strictEqual(session.config.referencePrice, null);
        assert.strictEqual(session.config.referenceCapturedAt, null);
        assert.strictEqual(session.state.lastPrice, null);
        assert.strictEqual(session.state.lastEventTimestamp, null);
        assert.deepStrictEqual(session.state.pendingBuyLevels, []);
    });

    await test("ADR-038: Start captures the reference and seeds the crossing watermark from it, immediately executing one BUY", async () => {
        const GridSimulatorSession = makeFakeSessionModel();
        const GridSimulatorTrade = makeFakeTradeModel();
        const userId = new mongoose.Types.ObjectId();
        const created = await createSession({ GridSimulatorSession, userId, instrumentKey: "NSE_EQ|WM2", symbol: "WM2", config: CONFIG });
        const started = await startSessionWithInitialBuy({ GridSimulatorSession, GridSimulatorTrade, sessionId: created._id, userId, referencePrice: REFERENCE_PRICE, referenceCapturedAt: REFERENCE_CAPTURED_AT });

        assert.strictEqual(started.config.referencePrice, REFERENCE_PRICE);
        assert.strictEqual(started.state.lastPrice, REFERENCE_PRICE);
        assert.strictEqual(new Date(started.state.lastEventTimestamp).getTime(), new Date(REFERENCE_CAPTURED_AT).getTime());
        assert.strictEqual(started.state.holdings, 100);
        assert.strictEqual(started.state.cash, CONFIG.startingCapital - 100 * REFERENCE_PRICE);

        const ledgerRows = await listTrades({ GridSimulatorTrade, sessionId: created._id, page: 1, limit: 10 });
        assert.strictEqual(ledgerRows.total, 1);
        assert.strictEqual(ledgerRows.items[0].type, "BUY");
        assert.strictEqual(ledgerRows.items[0].fillPrice, REFERENCE_PRICE);
        assert.strictEqual(ledgerRows.items[0].qtyFilled, 100);
    });

    await test("starting inventory establishes a correct realized-P&L baseline on a later sell (200 @ avg 315, Start buys 100 more @ 317, sell 320 crosses both armed sell targets)", async () => {
        const GridSimulatorSession = makeFakeSessionModel();
        const GridSimulatorTrade = makeFakeTradeModel();
        const userId = new mongoose.Types.ObjectId();
        const config = { ...CONFIG, startingHoldings: 200, startingAvgCost: 315 };
        const created = await createSession({ GridSimulatorSession, userId, instrumentKey: "NSE_EQ|INV2", symbol: "INV2", config });
        // ADR-038: Start itself immediately buys 100 more @ 317 (the captured
        // reference), on top of the 200 starting shares — arming its own
        // sell target (320) alongside the starting lot's (318).
        const started = await startSessionWithInitialBuy({ GridSimulatorSession, GridSimulatorTrade, sessionId: created._id, userId, referencePrice: 317, referenceCapturedAt: new Date(2026, 0, 1, 9, 0) });
        assert.strictEqual(started.state.holdings, 300);
        assert.deepStrictEqual(started.state.pendingSellLevels, [318, 320]);

        // A move to 320 crosses BOTH armed sell targets in one event.
        const result = await processTick({ GridSimulatorSession, GridSimulatorTrade, sessionId: started._id, price: 320, eventTimestamp: new Date(2026, 0, 1, 9, 30).toISOString() });
        assert.strictEqual(result.trades.length, 2);
        result.trades.forEach((trade) => {
            assert.strictEqual(trade.type, "SELL");
            assert.strictEqual(trade.qtyFilled, 100);
        });
        // FIFO: both sells consume the OLDEST (315) lot first — each
        // realizedPnLDelta = 100 * (320 - 315) = 500, for 1000 total.
        assert.strictEqual(result.state.realizedPnL, 1000);
        assert.strictEqual(result.state.holdings, 100); // only the 317 lot remains
        assert.strictEqual(result.state.avgCost, 317, "avg cost is now just the remaining 317 lot's own price");
    });

    // --- updateSessionConfig (ADR-034) ---

    await test("updateSessionConfig rejects editing an ACTIVE (not PAUSED) session", async () => {
        const { GridSimulatorSession, session, userId } = await makeActiveSession();
        await assert.rejects(
            () => updateSessionConfig({ GridSimulatorSession, sessionId: session._id, userId, patch: { quantityPerLevel: 50 } }),
            (err) => err.statusCode === 409,
        );
    });

    await test("updateSessionConfig applies quantityPerLevel/gridInterval/sellVariance and a cash top-up while PAUSED", async () => {
        const { GridSimulatorSession, session, userId } = await makeActiveSession();
        await pauseSession({ GridSimulatorSession, sessionId: session._id, userId });

        const updated = await updateSessionConfig({
            GridSimulatorSession,
            sessionId: session._id,
            userId,
            patch: { quantityPerLevel: 50, gridInterval: 4, sellVariance: 6, addCash: 25000 },
        });

        assert.strictEqual(updated.config.quantityPerLevel, 50);
        assert.strictEqual(updated.config.gridInterval, 4);
        assert.strictEqual(updated.config.sellVariance, 6);
        // ADR-038: Start itself already bought 100 @ 340 (REFERENCE_PRICE) before this top-up.
        assert.strictEqual(updated.state.cash, CONFIG.startingCapital - 100 * REFERENCE_PRICE + 25000);
    });

    await test("updateSessionConfig applies sellQuantityPerLevel (ADR-035), and clearing it mirrors quantityPerLevel again", async () => {
        const { GridSimulatorSession, session, userId } = await makeActiveSession();
        await pauseSession({ GridSimulatorSession, sessionId: session._id, userId });

        const withSplit = await updateSessionConfig({ GridSimulatorSession, sessionId: session._id, userId, patch: { sellQuantityPerLevel: 40 } });
        assert.strictEqual(withSplit.config.sellQuantityPerLevel, 40);
        assert.strictEqual(withSplit.config.quantityPerLevel, CONFIG.quantityPerLevel, "quantityPerLevel (buy qty) is untouched");

        const cleared = await updateSessionConfig({ GridSimulatorSession, sessionId: session._id, userId, patch: { sellQuantityPerLevel: null } });
        assert.strictEqual(cleared.config.sellQuantityPerLevel, null);
    });

    await test("updateSessionConfig with useSeparateSellVariance off (sellVariance: null) clears a previously-set sellVariance — mirrors gridInterval again", async () => {
        const { GridSimulatorSession, session, userId } = await makeActiveSession();
        await pauseSession({ GridSimulatorSession, sessionId: session._id, userId });
        await updateSessionConfig({ GridSimulatorSession, sessionId: session._id, userId, patch: { sellVariance: 6 } });

        const updated = await updateSessionConfig({ GridSimulatorSession, sessionId: session._id, userId, patch: { sellVariance: null } });
        assert.strictEqual(updated.config.sellVariance, null);
        assert.strictEqual(updated.config.gridInterval, CONFIG.gridInterval, "gridInterval (buy variance) is untouched by clearing sellVariance");
    });

    await test("updateSessionConfig rejects an invalid resulting configuration (e.g. a non-positive gridInterval)", async () => {
        const { GridSimulatorSession, session, userId } = await makeActiveSession();
        await pauseSession({ GridSimulatorSession, sessionId: session._id, userId });
        await assert.rejects(
            () => updateSessionConfig({ GridSimulatorSession, sessionId: session._id, userId, patch: { gridInterval: -1 } }),
            (err) => err.statusCode === 400,
        );
    });

    await test("updateSessionConfig 404s for a different user's session", async () => {
        const { GridSimulatorSession, session, userId } = await makeActiveSession();
        await pauseSession({ GridSimulatorSession, sessionId: session._id, userId });
        await assert.rejects(
            () => updateSessionConfig({ GridSimulatorSession, sessionId: session._id, userId: new mongoose.Types.ObjectId(), patch: { quantityPerLevel: 10 } }),
            (err) => err.statusCode === 404,
        );
    });

    // --- deleteSession ---

    await test("deleteSession removes the session document and its entire trade ledger, regardless of status", async () => {
        const { GridSimulatorSession, GridSimulatorTrade, session, userId } = await makeActiveSession();
        await processTick({ GridSimulatorSession, GridSimulatorTrade, sessionId: session._id, price: 337, eventTimestamp: new Date(2026, 0, 1, 9, 30).toISOString() });
        assert.ok(GridSimulatorTrade.docs.length > 0, "sanity check: a trade was actually recorded");

        await deleteSession({ GridSimulatorSession, GridSimulatorTrade, sessionId: session._id, userId });

        assert.strictEqual(GridSimulatorSession.docs.has(String(session._id)), false);
        assert.strictEqual(GridSimulatorTrade.docs.filter((t) => String(t.sessionId) === String(session._id)).length, 0);
    });

    await test("deleteSession 404s for a different user's session (no cross-user deletion)", async () => {
        const { GridSimulatorSession, GridSimulatorTrade, session } = await makeActiveSession();
        await assert.rejects(
            () => deleteSession({ GridSimulatorSession, GridSimulatorTrade, sessionId: session._id, userId: new mongoose.Types.ObjectId() }),
            (err) => err.statusCode === 404,
        );
    });

    console.log(`\nGrid simulator service tests: ${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
