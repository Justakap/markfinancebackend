/**
 * Workstream J — tests for services/liveStrategyOrchestrator.js using
 * in-memory fake Mongoose-like models (same dependency-injection
 * convention as professionalBacktestCandles.test.js — no live MongoDB).
 * The fakes implement findOneAndUpdate/create with the same
 * single-operation atomicity a real MongoDB server provides (the whole
 * operation runs with no `await` in between reading and writing), which
 * is what lets the concurrency tests below genuinely prove the orchestrator's
 * claim-lock logic, not just assume it.
 */
const assert = require("assert");
const mongoose = require("mongoose");

const {
    processRuntimeOnce,
    pollAllActiveRuntimes,
} = require("../services/liveStrategyOrchestrator");

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

function d(day, hour = 9, minute = 15) {
    return new Date(2024, 0, day, hour, minute).toISOString();
}
function bar(day, { open, high, low, close, volume = 1000 }) {
    return { date: d(day), open, high, low, close, volume };
}
function priceOp(field) {
    return { type: "price", field };
}
function constOp(value) {
    return { type: "constant", value };
}
function cond(left, operator, right) {
    return { type: "condition", left, operator, right };
}

// --- Minimal in-memory fake model, atomic findOneAndUpdate/create ---

function matchFilter(doc, filter = {}) {
    return Object.entries(filter).every(([key, cond_]) => {
        if (key === "$or") {
            return cond_.some((sub) => matchFilter(doc, sub));
        }
        if (cond_ !== null && typeof cond_ === "object" && !(cond_ instanceof Date)) {
            if ("$lte" in cond_) return doc[key] != null && new Date(doc[key]).getTime() <= new Date(cond_.$lte).getTime();
            if ("$lt" in cond_) return doc[key] != null && new Date(doc[key]).getTime() < new Date(cond_.$lt).getTime();
        }
        if (key === "_id") return String(doc._id) === String(cond_);
        if (cond_ === null) return doc[key] === null || doc[key] === undefined;
        return String(doc[key]) === String(cond_);
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

function makeFakeRuntimeModel(seedDocs = []) {
    const docs = new Map(seedDocs.map((doc) => [String(doc._id), JSON.parse(JSON.stringify(doc))]));

    return {
        async find(filter = {}) {
            return [...docs.values()].filter((doc) => matchFilter(doc, filter)).map((doc) => JSON.parse(JSON.stringify(doc)));
        },
        async findOne(filter = {}) {
            const found = [...docs.values()].find((doc) => matchFilter(doc, filter));
            return found ? JSON.parse(JSON.stringify(found)) : null;
        },
        // No `await` between the match check and the write — this is what
        // makes the fake a valid stand-in for MongoDB's real atomic
        // findOneAndUpdate for the purposes of this test.
        async findOneAndUpdate(filter, update, _opts) {
            const found = [...docs.values()].find((doc) => matchFilter(doc, filter));
            if (!found) return null;
            if (update.$set) applySet(found, update.$set);
            docs.set(String(found._id), found);
            return JSON.parse(JSON.stringify(found));
        },
        async create(doc) {
            const existing = [...docs.values()].find(
                (d) => d.status === "ACTIVE" && String(d.userId) === String(doc.userId) && String(d.strategyId) === String(doc.strategyId) && d.instrumentKey === doc.instrumentKey && d.timeframe === doc.timeframe,
            );
            if (existing) {
                const error = new Error("duplicate key");
                error.code = 11000;
                throw error;
            }
            const _id = new mongoose.Types.ObjectId();
            const toInsert = { _id, ...JSON.parse(JSON.stringify(doc)), createdAt: new Date(), updatedAt: new Date() };
            docs.set(String(_id), toInsert);
            return JSON.parse(JSON.stringify(toInsert));
        },
        _raw: docs,
    };
}

function makeFakeSignalModel() {
    const inserted = [];
    return {
        async insertMany(rows) {
            inserted.push(...rows);
            return rows;
        },
        _inserted: inserted,
    };
}

function makeRuntimeDoc(overrides = {}) {
    return {
        _id: new mongoose.Types.ObjectId(),
        userId: new mongoose.Types.ObjectId(),
        strategyId: new mongoose.Types.ObjectId(),
        strategyVersionId: new mongoose.Types.ObjectId(),
        instrumentKey: "NSE_EQ|LIVETEST01",
        symbol: "LIVETESTSTOCK",
        timeframe: "1d",
        status: "ACTIVE",
        config: { initialCapital: 10000, commissionPct: 0, slippagePct: 0 },
        engineState: {
            equity: 10000,
            peakEquity: 10000,
            barsProcessed: 0,
            inPosition: false,
            entryPrice: 0,
            entryRawPrice: 0,
            entryDate: null,
            quantity: 0,
            entrySignalBarIndex: null,
            pendingEntry: false,
            pendingExit: false,
            pendingExitReason: null,
        },
        lastProcessedCandleTimestamp: null,
        lastEvaluationAt: null,
        lastEvaluationStatus: "Activated",
        processingLockedUntil: null,
        deactivatedAt: null,
        ...overrides,
    };
}

function definitionFixture() {
    return {
        version: 2,
        universe: { timeframe: "1d" },
        entry: cond(priceOp("close"), "CROSSES_ABOVE", constOp(100)),
        exit: cond(priceOp("close"), "CROSSES_BELOW", constOp(90)),
    };
}

console.log("Workstream J — liveStrategyOrchestrator (dedup, concurrency, restart recovery)\n");

(async () => {
    await test("Processes new completed bars and commits engineState + lastProcessedCandleTimestamp", async () => {
        const candles = [
            bar(1, { open: 95, high: 96, low: 94, close: 95 }),
            bar(2, { open: 96, high: 102, low: 95, close: 101 }),
            bar(3, { open: 103, high: 105, low: 102, close: 104 }),
        ];
        const runtimeDoc = makeRuntimeDoc();
        const LiveStrategyRuntime = makeFakeRuntimeModel([runtimeDoc]);
        const LiveStrategySignal = makeFakeSignalModel();

        const result = await processRuntimeOnce(runtimeDoc, {
            LiveStrategyRuntime,
            LiveStrategySignal,
            definition: definitionFixture(),
            deps: { fetchLatestClosedCandles: async () => candles },
        });

        assert.strictEqual(result.skipped, false);
        assert.strictEqual(result.processedBars, 2); // startIndex=1 for a bare condition -> bars[1],bars[2]

        const committed = await LiveStrategyRuntime.findOne({ _id: runtimeDoc._id });
        assert.strictEqual(new Date(committed.lastProcessedCandleTimestamp).toISOString(), new Date(candles[2].date).toISOString());
        assert.strictEqual(committed.processingLockedUntil, null);
    });

    await test("Duplicate poll with no new bars is a safe no-op (no reprocessing, no duplicate signals)", async () => {
        const candles = [bar(1, { open: 95, high: 96, low: 94, close: 95 }), bar(2, { open: 96, high: 102, low: 95, close: 101 })];
        const runtimeDoc = makeRuntimeDoc({ lastProcessedCandleTimestamp: candles[1].date });
        const LiveStrategyRuntime = makeFakeRuntimeModel([runtimeDoc]);
        const LiveStrategySignal = makeFakeSignalModel();

        const result = await processRuntimeOnce(runtimeDoc, {
            LiveStrategyRuntime,
            LiveStrategySignal,
            definition: definitionFixture(),
            deps: { fetchLatestClosedCandles: async () => candles },
        });

        assert.strictEqual(result.skipped, true);
        assert.strictEqual(result.reason, "no-new-bars");
        assert.strictEqual(LiveStrategySignal._inserted.length, 0);
    });

    await test("Out-of-order / already-seen bars reappearing in a later fetch are never reprocessed", async () => {
        const candles = [
            bar(1, { open: 95, high: 96, low: 94, close: 95 }),
            bar(2, { open: 96, high: 102, low: 95, close: 101 }),
            bar(3, { open: 103, high: 105, low: 102, close: 104 }),
        ];
        // Watermark already past bar 2 — only bar 3 should ever be processed,
        // even though bars 1 and 2 are present again in this fetch.
        const runtimeDoc = makeRuntimeDoc({ lastProcessedCandleTimestamp: candles[1].date });
        const LiveStrategyRuntime = makeFakeRuntimeModel([runtimeDoc]);
        const LiveStrategySignal = makeFakeSignalModel();

        const result = await processRuntimeOnce(runtimeDoc, {
            LiveStrategyRuntime,
            LiveStrategySignal,
            definition: definitionFixture(),
            deps: { fetchLatestClosedCandles: async () => candles },
        });

        assert.strictEqual(result.processedBars, 1);
    });

    await test("Stale/empty candle data is handled safely (no crash, lock released, clear status message)", async () => {
        const runtimeDoc = makeRuntimeDoc();
        const LiveStrategyRuntime = makeFakeRuntimeModel([runtimeDoc]);
        const LiveStrategySignal = makeFakeSignalModel();

        const result = await processRuntimeOnce(runtimeDoc, {
            LiveStrategyRuntime,
            LiveStrategySignal,
            definition: definitionFixture(),
            deps: { fetchLatestClosedCandles: async () => [] },
        });

        assert.strictEqual(result.skipped, true);
        assert.strictEqual(result.reason, "no-candle-data");
        const committed = await LiveStrategyRuntime.findOne({ _id: runtimeDoc._id });
        assert.strictEqual(committed.processingLockedUntil, null);
    });

    await test("Concurrent duplicate processing: two simultaneous calls against the same runtime never double-process", async () => {
        const candles = [
            bar(1, { open: 95, high: 96, low: 94, close: 95 }),
            bar(2, { open: 96, high: 102, low: 95, close: 101 }),
            bar(3, { open: 103, high: 105, low: 102, close: 104 }),
        ];
        const runtimeDoc = makeRuntimeDoc();
        const LiveStrategyRuntime = makeFakeRuntimeModel([runtimeDoc]);
        const LiveStrategySignal = makeFakeSignalModel();

        const deps = { fetchLatestClosedCandles: async () => candles };
        const [resultA, resultB] = await Promise.all([
            processRuntimeOnce(runtimeDoc, { LiveStrategyRuntime, LiveStrategySignal, definition: definitionFixture(), deps }),
            processRuntimeOnce(runtimeDoc, { LiveStrategyRuntime, LiveStrategySignal, definition: definitionFixture(), deps }),
        ]);

        const outcomes = [resultA, resultB];
        const succeeded = outcomes.filter((r) => !r.skipped);
        const lockedOut = outcomes.filter((r) => r.skipped && r.reason === "locked-by-another-worker-or-inactive");

        assert.strictEqual(succeeded.length, 1, "exactly one of the two concurrent calls must win the claim");
        assert.strictEqual(lockedOut.length, 1, "the other must be rejected by the lock, not silently also process");
    });

    await test("Restart recovery: a fresh call against already-persisted engineState resumes correctly, does not lose an open position", async () => {
        // Simulates: a prior process ran, opened a position, committed
        // state, then the process restarted (new JS module state, but the
        // SAME persisted document) — exactly what the fake re-reading
        // `findOne` represents here.
        const persistedAfterFirstRun = makeRuntimeDoc({
            lastProcessedCandleTimestamp: d(3),
            engineState: {
                equity: 10000,
                peakEquity: 10000,
                barsProcessed: 3,
                inPosition: true,
                entryPrice: 103,
                entryRawPrice: 103,
                entryDate: d(3),
                quantity: 97.08737864077669,
                entrySignalBarIndex: 2,
                pendingEntry: false,
                pendingExit: false,
                pendingExitReason: null,
            },
        });
        const LiveStrategyRuntime = makeFakeRuntimeModel([persistedAfterFirstRun]);
        const LiveStrategySignal = makeFakeSignalModel();

        const candles = [
            bar(1, { open: 95, high: 96, low: 94, close: 95 }),
            bar(2, { open: 96, high: 102, low: 95, close: 101 }),
            bar(3, { open: 103, high: 105, low: 102, close: 104 }),
            bar(4, { open: 104, high: 106, low: 103, close: 89 }), // exit signal
            bar(5, { open: 89, high: 90, low: 85, close: 88 }), // exit fills here
        ];

        const result = await processRuntimeOnce(persistedAfterFirstRun, {
            LiveStrategyRuntime,
            LiveStrategySignal,
            definition: definitionFixture(),
            deps: { fetchLatestClosedCandles: async () => candles },
        });

        assert.strictEqual(result.processedBars, 2); // bars 4 and 5 only — 1-3 already processed before "restart"
        const exitEvent = result.events.find((e) => e.type === "EXIT_FILLED");
        assert.ok(exitEvent, "the position opened before the simulated restart must still be tracked and eventually closed");
        assert.strictEqual(exitEvent.entryPrice, 103);
        assert.strictEqual(exitEvent.price, 89);

        const committed = await LiveStrategyRuntime.findOne({ _id: persistedAfterFirstRun._id });
        assert.strictEqual(committed.engineState.inPosition, false);
    });

    await test("pollAllActiveRuntimes isolates one runtime's failure from the rest of the fleet", async () => {
        const goodRuntime = makeRuntimeDoc();
        const badRuntime = makeRuntimeDoc({ strategyVersionId: new mongoose.Types.ObjectId() }); // no matching version below
        const LiveStrategyRuntime = makeFakeRuntimeModel([goodRuntime, badRuntime]);
        const LiveStrategySignal = makeFakeSignalModel();
        const StrategyVersion = {
            async findOne(filter) {
                if (String(filter._id) === String(goodRuntime.strategyVersionId)) {
                    return { _id: goodRuntime.strategyVersionId, definition: definitionFixture() };
                }
                return null; // simulates a missing/deleted version for the bad runtime
            },
        };

        const results = await pollAllActiveRuntimes({
            LiveStrategyRuntime,
            LiveStrategySignal,
            StrategyVersion,
            deps: { fetchLatestClosedCandles: async () => [bar(1, { open: 95, high: 96, low: 94, close: 95 }), bar(2, { open: 96, high: 102, low: 95, close: 101 })] },
        });

        const goodResult = results.find((r) => String(r.runtimeId) === String(goodRuntime._id));
        const badResult = results.find((r) => String(r.runtimeId) === String(badRuntime._id));
        assert.strictEqual(goodResult.skipped, false);
        assert.strictEqual(badResult.skipped, true);
        assert.strictEqual(badResult.reason, "strategy-version-not-found");
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
