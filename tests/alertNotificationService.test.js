/**
 * Workstream K — tests for services/alertNotificationService.js using
 * in-memory fake Mongoose-like models (same convention as
 * tests/liveStrategyOrchestrator.test.js — atomic findOneAndUpdate with
 * no `await` between read-check and write, so concurrency tests are
 * genuine, not simulated).
 */
const assert = require("assert");
const mongoose = require("mongoose");

const { processAlertConfiguration, pollAllActiveAlertConfigurations } = require("../services/alertNotificationService");

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
            if ("$lt" in cond) return doc[key] != null && new Date(doc[key]).getTime() < new Date(cond.$lt).getTime();
            if ("$gt" in cond) return doc[key] != null && String(doc[key]) > String(cond.$gt);
            if ("$in" in cond) return cond.$in.includes(doc[key]);
        }
        if (key === "_id" || key === "runtimeId") return String(doc[key]) === String(cond);
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

function makeFakeAlertConfigModel(seedDocs = []) {
    const docs = new Map(seedDocs.map((d) => [String(d._id), JSON.parse(JSON.stringify(d))]));
    return {
        async find(filter = {}) {
            return [...docs.values()].filter((d) => matchFilter(d, filter)).map((d) => JSON.parse(JSON.stringify(d)));
        },
        async findOne(filter = {}) {
            const found = [...docs.values()].find((d) => matchFilter(d, filter));
            return found ? JSON.parse(JSON.stringify(found)) : null;
        },
        async findOneAndUpdate(filter, update) {
            const found = [...docs.values()].find((d) => matchFilter(d, filter));
            if (!found) return null;
            if (update.$set) applySet(found, update.$set);
            docs.set(String(found._id), found);
            return JSON.parse(JSON.stringify(found));
        },
        _raw: docs,
    };
}

function makeFakeRuntimeModel(seedDocs = []) {
    const docs = new Map(seedDocs.map((d) => [String(d._id), d]));
    return {
        async findOne(filter = {}) {
            return [...docs.values()].find((d) => matchFilter(d, filter)) || null;
        },
    };
}

function makeChainable(items) {
    const q = {
        sort() {
            return q;
        },
        limit() {
            return q;
        },
        then(resolve, reject) {
            return Promise.resolve(items).then(resolve, reject);
        },
    };
    return q;
}

function makeFakeSignalModel(signals) {
    return {
        find(filter = {}) {
            const matched = signals.filter((s) => matchFilter(s, filter)).sort((a, b) => String(a._id).localeCompare(String(b._id)));
            return makeChainable(matched);
        },
    };
}

function makeFakeNotificationModel() {
    const docs = [];
    const seen = new Set();
    let failNextWith = null;

    return {
        async insertMany(rows) {
            if (failNextWith) {
                const err = failNextWith;
                failNextWith = null;
                throw err;
            }
            const writeErrors = [];
            rows.forEach((row) => {
                const key = `${row.alertConfigurationId}:${row.sourceSignalId}`;
                if (seen.has(key)) {
                    writeErrors.push({ code: 11000 });
                    return;
                }
                seen.add(key);
                docs.push({ _id: new mongoose.Types.ObjectId(), ...row, read: false, readAt: null, createdAt: new Date() });
            });
            if (writeErrors.length) {
                const error = new Error("E11000 duplicate key (simulated)");
                error.writeErrors = writeErrors;
                throw error;
            }
            return rows;
        },
        _docs: docs,
        _failNextWith(error) {
            failNextWith = error;
        },
    };
}

function makeConfigDoc(overrides = {}) {
    return {
        _id: new mongoose.Types.ObjectId(),
        userId: new mongoose.Types.ObjectId(),
        runtimeId: new mongoose.Types.ObjectId(),
        strategyId: new mongoose.Types.ObjectId(),
        eventTypes: ["ENTRY_SIGNAL", "EXIT_SIGNAL", "ENTRY_FILLED", "EXIT_FILLED"],
        enabled: true,
        status: "ACTIVE",
        cursor: { lastAlertedSignalId: null },
        processingLockedUntil: null,
        ...overrides,
    };
}

function makeSignal({ runtimeId, type, n }) {
    // ObjectId-like ordering via a monotonic hex suffix so `_id` sort works
    // the same way real ObjectIds' creation-time ordering would.
    const id = new mongoose.Types.ObjectId(`${n.toString(16).padStart(24, "0")}`);
    return { _id: id, runtimeId, type, price: 100 + n, quantity: 10, exitReason: "SIGNAL", netPnl: 5, returnPct: 1, barDate: new Date(2024, 0, n) };
}

console.log("Workstream K — alertNotificationService\n");

(async () => {
    await test("Processes new signals and advances the cursor to the last processed signal", async () => {
        const runtimeId = new mongoose.Types.ObjectId();
        const config = makeConfigDoc({ runtimeId });
        const signals = [1, 2, 3].map((n) => makeSignal({ runtimeId, type: "ENTRY_SIGNAL", n }));

        const AlertConfiguration = makeFakeAlertConfigModel([config]);
        const LiveStrategyRuntime = makeFakeRuntimeModel([{ _id: runtimeId, symbol: "X", timeframe: "1d" }]);
        const LiveStrategySignal = makeFakeSignalModel(signals);
        const Notification = makeFakeNotificationModel();

        const result = await processAlertConfiguration(config, { LiveStrategyRuntime, LiveStrategySignal, AlertConfiguration, Notification });

        assert.strictEqual(result.skipped, false);
        assert.strictEqual(result.processedSignals, 3);
        assert.strictEqual(Notification._docs.length, 3);
        const committed = await AlertConfiguration.findOne({ _id: config._id });
        assert.strictEqual(String(committed.cursor.lastAlertedSignalId), String(signals[2]._id));
        assert.strictEqual(committed.processingLockedUntil, null);
    });

    await test("A disabled configuration is never processed", async () => {
        const runtimeId = new mongoose.Types.ObjectId();
        const config = makeConfigDoc({ runtimeId, enabled: false });
        const signals = [makeSignal({ runtimeId, type: "ENTRY_SIGNAL", n: 1 })];

        const AlertConfiguration = makeFakeAlertConfigModel([config]);
        const LiveStrategyRuntime = makeFakeRuntimeModel([{ _id: runtimeId, symbol: "X", timeframe: "1d" }]);
        const LiveStrategySignal = makeFakeSignalModel(signals);
        const Notification = makeFakeNotificationModel();

        const result = await processAlertConfiguration(config, { LiveStrategyRuntime, LiveStrategySignal, AlertConfiguration, Notification });
        assert.strictEqual(result.skipped, true);
        assert.strictEqual(Notification._docs.length, 0);
    });

    await test("Event-type filtering: only enabled event types produce notifications", async () => {
        const runtimeId = new mongoose.Types.ObjectId();
        const config = makeConfigDoc({ runtimeId, eventTypes: ["EXIT_FILLED"] });
        const signals = [
            makeSignal({ runtimeId, type: "ENTRY_SIGNAL", n: 1 }),
            makeSignal({ runtimeId, type: "ENTRY_FILLED", n: 2 }),
            makeSignal({ runtimeId, type: "EXIT_FILLED", n: 3 }),
        ];

        const AlertConfiguration = makeFakeAlertConfigModel([config]);
        const LiveStrategyRuntime = makeFakeRuntimeModel([{ _id: runtimeId, symbol: "X", timeframe: "1d" }]);
        const LiveStrategySignal = makeFakeSignalModel(signals);
        const Notification = makeFakeNotificationModel();

        const result = await processAlertConfiguration(config, { LiveStrategyRuntime, LiveStrategySignal, AlertConfiguration, Notification });
        assert.strictEqual(result.processedSignals, 1);
        assert.strictEqual(Notification._docs[0].type, "EXIT_FILLED");
    });

    await test("Re-running with no new signals since the cursor is a safe no-op", async () => {
        const runtimeId = new mongoose.Types.ObjectId();
        const signals = [makeSignal({ runtimeId, type: "ENTRY_SIGNAL", n: 1 })];
        const config = makeConfigDoc({ runtimeId, cursor: { lastAlertedSignalId: signals[0]._id } });

        const AlertConfiguration = makeFakeAlertConfigModel([config]);
        const LiveStrategyRuntime = makeFakeRuntimeModel([{ _id: runtimeId, symbol: "X", timeframe: "1d" }]);
        const LiveStrategySignal = makeFakeSignalModel(signals);
        const Notification = makeFakeNotificationModel();

        const result = await processAlertConfiguration(config, { LiveStrategyRuntime, LiveStrategySignal, AlertConfiguration, Notification });
        assert.strictEqual(result.skipped, true);
        assert.strictEqual(result.reason, "no-new-signals");
        assert.strictEqual(Notification._docs.length, 0);
    });

    await test("Duplicate notification attempts (re-processing the same signals) never create a second row — unique-index dedup", async () => {
        const runtimeId = new mongoose.Types.ObjectId();
        const config = makeConfigDoc({ runtimeId });
        const signals = [makeSignal({ runtimeId, type: "ENTRY_SIGNAL", n: 1 })];

        const AlertConfiguration = makeFakeAlertConfigModel([config]);
        const LiveStrategyRuntime = makeFakeRuntimeModel([{ _id: runtimeId, symbol: "X", timeframe: "1d" }]);
        const LiveStrategySignal = makeFakeSignalModel(signals);
        const Notification = makeFakeNotificationModel();

        // Simulate the exact "crash before cursor commit" scenario: process
        // the batch once without ever advancing the cursor (by resetting the
        // config's cursor back), forcing a genuine re-attempt at the same
        // signal through the same Notification model instance.
        await processAlertConfiguration(config, { LiveStrategyRuntime, LiveStrategySignal, AlertConfiguration, Notification });
        await AlertConfiguration.findOneAndUpdate({ _id: config._id }, { $set: { "cursor.lastAlertedSignalId": null, processingLockedUntil: null } });
        const staleConfig = await AlertConfiguration.findOne({ _id: config._id });

        const secondResult = await processAlertConfiguration(staleConfig, { LiveStrategyRuntime, LiveStrategySignal, AlertConfiguration, Notification });

        assert.strictEqual(secondResult.skipped, false, "the processor itself still ran (it doesn't know the cursor was artificially reset)");
        assert.strictEqual(Notification._docs.length, 1, "exactly one notification must exist for this signal, never two");
    });

    await test("Concurrent processing of the same configuration: exactly one call wins the lock", async () => {
        const runtimeId = new mongoose.Types.ObjectId();
        const config = makeConfigDoc({ runtimeId });
        const signals = [makeSignal({ runtimeId, type: "ENTRY_SIGNAL", n: 1 })];

        const AlertConfiguration = makeFakeAlertConfigModel([config]);
        const LiveStrategyRuntime = makeFakeRuntimeModel([{ _id: runtimeId, symbol: "X", timeframe: "1d" }]);
        const LiveStrategySignal = makeFakeSignalModel(signals);
        const Notification = makeFakeNotificationModel();

        const [a, b] = await Promise.all([
            processAlertConfiguration(config, { LiveStrategyRuntime, LiveStrategySignal, AlertConfiguration, Notification }),
            processAlertConfiguration(config, { LiveStrategyRuntime, LiveStrategySignal, AlertConfiguration, Notification }),
        ]);

        const winners = [a, b].filter((r) => !r.skipped);
        const losers = [a, b].filter((r) => r.skipped && r.reason === "locked-or-inactive");
        assert.strictEqual(winners.length, 1);
        assert.strictEqual(losers.length, 1);
        assert.strictEqual(Notification._docs.length, 1);
    });

    await test("A genuine (non-duplicate-key) failure releases the lock and does NOT advance the cursor, so the batch is retried later", async () => {
        const runtimeId = new mongoose.Types.ObjectId();
        const config = makeConfigDoc({ runtimeId });
        const signals = [makeSignal({ runtimeId, type: "ENTRY_SIGNAL", n: 1 })];

        const AlertConfiguration = makeFakeAlertConfigModel([config]);
        const LiveStrategyRuntime = makeFakeRuntimeModel([{ _id: runtimeId, symbol: "X", timeframe: "1d" }]);
        const LiveStrategySignal = makeFakeSignalModel(signals);
        const Notification = makeFakeNotificationModel();
        Notification._failNextWith(new Error("simulated transient DB failure"));

        await assert.rejects(() => processAlertConfiguration(config, { LiveStrategyRuntime, LiveStrategySignal, AlertConfiguration, Notification }));

        const afterFailure = await AlertConfiguration.findOne({ _id: config._id });
        assert.strictEqual(afterFailure.cursor.lastAlertedSignalId, null);
        assert.strictEqual(afterFailure.processingLockedUntil, null, "lock must be released even on failure");
        assert.strictEqual(Notification._docs.length, 0);

        // Retry succeeds now that the transient failure is gone.
        const retryResult = await processAlertConfiguration(afterFailure, { LiveStrategyRuntime, LiveStrategySignal, AlertConfiguration, Notification });
        assert.strictEqual(retryResult.skipped, false);
        assert.strictEqual(Notification._docs.length, 1);
    });

    await test("A missing LiveStrategyRuntime is handled safely (skipped, lock released, no crash)", async () => {
        const runtimeId = new mongoose.Types.ObjectId();
        const config = makeConfigDoc({ runtimeId });
        const AlertConfiguration = makeFakeAlertConfigModel([config]);
        const LiveStrategyRuntime = makeFakeRuntimeModel([]); // runtime deleted/missing
        const LiveStrategySignal = makeFakeSignalModel([makeSignal({ runtimeId, type: "ENTRY_SIGNAL", n: 1 })]);
        const Notification = makeFakeNotificationModel();

        const result = await processAlertConfiguration(config, { LiveStrategyRuntime, LiveStrategySignal, AlertConfiguration, Notification });
        assert.strictEqual(result.skipped, true);
        assert.strictEqual(result.reason, "runtime-not-found");
    });

    await test("pollAllActiveAlertConfigurations isolates one configuration's failure from the rest", async () => {
        const runtimeId = new mongoose.Types.ObjectId();
        const goodConfig = makeConfigDoc({ runtimeId });
        const badConfig = makeConfigDoc({ runtimeId: new mongoose.Types.ObjectId() }); // no matching runtime below

        const AlertConfiguration = makeFakeAlertConfigModel([goodConfig, badConfig]);
        const LiveStrategyRuntime = makeFakeRuntimeModel([{ _id: runtimeId, symbol: "X", timeframe: "1d" }]);
        const LiveStrategySignal = makeFakeSignalModel([makeSignal({ runtimeId, type: "ENTRY_SIGNAL", n: 1 })]);
        const Notification = makeFakeNotificationModel();

        const results = await pollAllActiveAlertConfigurations({ LiveStrategyRuntime, LiveStrategySignal, AlertConfiguration, Notification });

        const goodResult = results.find((r) => String(r.configId) === String(goodConfig._id));
        const badResult = results.find((r) => String(r.configId) === String(badConfig._id));
        assert.strictEqual(goodResult.skipped, false);
        assert.strictEqual(badResult.skipped, true);
        assert.strictEqual(badResult.reason, "runtime-not-found");
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
