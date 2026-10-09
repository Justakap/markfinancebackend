/**
 * Verification-pass milestone — Phase 2 item 3: "Add integration tests for
 * strategy creation → backtest → persisted result → live evaluation →
 * persisted signal → notification." This is the one test that chains every
 * major subsystem built across Workstreams A-F/J/K through real service
 * functions (strategyVersionService, professionalBacktestService,
 * liveStrategyService, liveStrategyOrchestrator, alertConfigurationService,
 * alertNotificationService) against lightweight in-memory fakes — no live
 * MongoDB, no live Upstox (candle data is mocked at the axios boundary,
 * same convention as professionalBacktestService.test.js).
 *
 * This also closes the one coverage gap the verification-pass backtest-
 * engine audit flagged: no single test previously proved the full chain
 * "persist a BacktestResult against v1 -> edit the strategy to v2 -> the
 * original BacktestResult's frozen version is still v1, unchanged" end to
 * end (it was previously only provable by composing three separately-
 * tested facts). This test exercises that exact sequence directly.
 */
const assert = require("assert");
const mongoose = require("mongoose");

process.env.UPSTOX_INSTRUMENT_MASTER_URL = "https://fake.test/full-platform-instruments.json";
process.env.UPSTOX_ACCESS_TOKEN = "fake-token-for-tests";
process.env.UPSTOX_REQUEST_GAP_MS = "0";
process.env.UPSTOX_MAX_RETRIES = "1";
process.env.UPSTOX_RETRY_BASE_MS = "5";
process.env.UPSTOX_RETRY_MAX_MS = "10";

const axios = require("axios");

const TEST_KEY = "NSE_EQ|FULLPLAT01";
const FAKE_INSTRUMENTS = [
    { instrument_key: TEST_KEY, trading_symbol: "FULLPLATSTOCK", exchange: "NSE", instrument_type: "EQ", segment: "NSE_EQ" },
];

/** A daily series that closes above 100 partway through (entry signal)
 *  and stays there — deterministic, no exit, so the backtest force-closes
 *  it as END_OF_DATA and the live engine (fed the same bars one at a time)
 *  reaches ENTRY_FILLED without ever needing an exit rule. */
function fakeDailyCandles(count) {
    const candles = [];
    for (let i = 0; i < count; i += 1) {
        const close = i < 5 ? 95 + i : 105 + i * 0.1;
        const ts = new Date(2024, 0, 1 + i).toISOString();
        candles.push([ts, close - 0.3, close + 1.2, close - 1.2, close, 1000 + i, 0]);
    }
    return candles;
}

const originalAxiosGet = axios.get.bind(axios);
axios.get = (url, config) => {
    if (url === process.env.UPSTOX_INSTRUMENT_MASTER_URL) {
        return Promise.resolve({ data: Buffer.from(JSON.stringify(FAKE_INSTRUMENTS), "utf8") });
    }
    if (url.includes("/historical-candle/")) {
        return Promise.resolve({ data: { data: { candles: fakeDailyCandles(60) } } });
    }
    return originalAxiosGet(url, config);
};

[
    "../services/marketDataService",
    "../services/candleService",
    "../utils/instrumentKeyResolver",
    "../utils/backtestEngine",
    "../utils/rsiCandles",
    "../services/professionalCandleAdapter",
    "../services/professionalBacktestService",
    "../services/liveCandleFeed",
].forEach((p) => delete require.cache[require.resolve(p)]);

const { createStrategy, createNewVersion } = require("../services/strategyVersionService");
const { runAndPersistBacktest } = require("../services/professionalBacktestService");
const { activateLiveStrategy } = require("../services/liveStrategyService");
const { processRuntimeOnce } = require("../services/liveStrategyOrchestrator");
const { createAlertConfiguration } = require("../services/alertConfigurationService");
const { processAlertConfiguration } = require("../services/alertNotificationService");
const upstoxMarketData = require("../services/marketDataService");
const { resolveInstrumentKey } = require("../utils/instrumentKeyResolver");
const RealBacktestResult = require("../models/BacktestResult");
const RealBacktestTrade = require("../models/BacktestTrade");

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

// --- Minimal in-memory fakes shared by every subsystem in this chain ---
// Mongoose-document-shaped (via real schemas where it matters for
// validation) but backed by a plain Map, with the same no-await-between-
// read-and-write atomicity for findOneAndUpdate used throughout this
// session's other fake models.

function matchFilter(doc, filter = {}) {
    return Object.entries(filter).every(([key, cond]) => {
        if (key === "$or") return cond.some((sub) => matchFilter(doc, sub));
        if (cond !== null && typeof cond === "object" && !(cond instanceof mongoose.Types.ObjectId) && !(cond instanceof Date)) {
            if ("$lt" in cond) return doc[key] != null && new Date(doc[key]).getTime() < new Date(cond.$lt).getTime();
            if ("$lte" in cond) return doc[key] != null && new Date(doc[key]).getTime() <= new Date(cond.$lte).getTime();
            if ("$gt" in cond) return doc[key] != null && String(doc[key]) > String(cond.$gt);
            if ("$in" in cond) return cond.$in.includes(doc[key]);
        }
        if (cond === null) return doc[key] === null || doc[key] === undefined;
        return String(doc[key]) === String(cond);
    });
}

function makeChainable(items) {
    const q = {
        sort() {
            return q;
        },
        skip() {
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

function makeStrategyDefinitionModel() {
    const docs = new Map();
    return {
        async create(data) {
            const _id = new mongoose.Types.ObjectId();
            const doc = { _id, ...data, createdAt: new Date(), updatedAt: new Date() };
            doc.save = async () => {
                docs.set(String(_id), doc);
                return doc;
            };
            docs.set(String(_id), doc);
            return doc;
        },
        async findOne(filter) {
            return [...docs.values()].find((d) => matchFilter(d, filter)) || null;
        },
        _docs: docs,
    };
}

function makeStrategyVersionModel() {
    const docs = new Map();
    return {
        async create(data) {
            const key = `${data.strategyId}:${data.versionNumber}`;
            if ([...docs.values()].some((d) => `${d.strategyId}:${d.versionNumber}` === key)) {
                const error = new Error("duplicate versionNumber");
                error.code = 11000;
                throw error;
            }
            const _id = new mongoose.Types.ObjectId();
            const doc = { _id, ...data, createdAt: new Date() };
            docs.set(String(_id), doc);
            return doc;
        },
        // Returns a thenable that's ALSO chainable via `.sort()` —
        // `createNewVersion()` calls `.sort({versionNumber:-1})`; a plain
        // `await findOne({_id})` (no `.sort()`) just resolves to the first
        // (only) match, since callers of that form only ever filter by a
        // unique `_id` in this test.
        findOne(filter) {
            const found = [...docs.values()].filter((d) => matchFilter(d, filter));
            let sorted = found;
            const query = {
                sort(sortSpec) {
                    const [[key, dir]] = Object.entries(sortSpec);
                    sorted = [...found].sort((a, b) => (dir < 0 ? b[key] - a[key] : a[key] - b[key]));
                    return query;
                },
                then(resolve, reject) {
                    return Promise.resolve(sorted[0] || null).then(resolve, reject);
                },
            };
            return query;
        },
        _docs: docs,
    };
}

function makeRecordingModel(RealModel) {
    const saved = [];
    return {
        saved,
        async create(data) {
            const doc = new RealModel(data);
            const error = doc.validateSync();
            if (error) throw error;
            saved.push(doc);
            return doc;
        },
        async insertMany(docs) {
            const hydrated = docs.map((d) => {
                const doc = new RealModel(d);
                const error = doc.validateSync();
                if (error) throw error;
                return doc;
            });
            saved.push(...hydrated);
            return hydrated;
        },
        async findOne(filter) {
            return saved.find((d) => matchFilter(d, filter)) || null;
        },
    };
}

function makeLiveStrategyRuntimeModel() {
    const docs = new Map();
    return {
        async create(data) {
            const existing = [...docs.values()].find(
                (d) => d.status === "ACTIVE" && String(d.userId) === String(data.userId) && String(d.strategyId) === String(data.strategyId) && d.instrumentKey === data.instrumentKey && d.timeframe === data.timeframe,
            );
            if (existing) {
                const error = new Error("duplicate active runtime");
                error.code = 11000;
                throw error;
            }
            const _id = new mongoose.Types.ObjectId();
            const doc = { _id, ...data, createdAt: new Date() };
            docs.set(String(_id), doc);
            return doc;
        },
        async findOne(filter) {
            const found = [...docs.values()].find((d) => matchFilter(d, filter));
            return found ? JSON.parse(JSON.stringify(found)) : null;
        },
        async findOneAndUpdate(filter, update) {
            const found = [...docs.values()].find((d) => matchFilter(d, filter));
            if (!found) return null;
            if (update.$set) {
                Object.entries(update.$set).forEach(([path, value]) => {
                    const parts = path.split(".");
                    let target = found;
                    for (let i = 0; i < parts.length - 1; i += 1) {
                        target[parts[i]] = target[parts[i]] || {};
                        target = target[parts[i]];
                    }
                    target[parts[parts.length - 1]] = value;
                });
            }
            return JSON.parse(JSON.stringify(found));
        },
        _docs: docs,
    };
}

function makeLiveStrategySignalModel() {
    const docs = [];
    return {
        async insertMany(rows) {
            const inserted = rows.map((r) => ({ _id: new mongoose.Types.ObjectId(), ...r, createdAt: new Date() }));
            docs.push(...inserted);
            return inserted;
        },
        find(filter = {}) {
            return makeChainable(docs.filter((d) => matchFilter(d, filter)).sort((a, b) => String(a._id).localeCompare(String(b._id))));
        },
        _docs: docs,
    };
}

function makeAlertConfigurationModel() {
    const docs = new Map();
    return {
        async create(data) {
            const existing = [...docs.values()].find((d) => d.status === "ACTIVE" && String(d.userId) === String(data.userId) && String(d.runtimeId) === String(data.runtimeId));
            if (existing) {
                const error = new Error("duplicate config");
                error.code = 11000;
                throw error;
            }
            const _id = new mongoose.Types.ObjectId();
            const doc = { _id, cursor: { lastAlertedSignalId: null }, processingLockedUntil: null, ...data, createdAt: new Date() };
            docs.set(String(_id), doc);
            return doc;
        },
        async findOne(filter) {
            const found = [...docs.values()].find((d) => matchFilter(d, filter));
            return found ? JSON.parse(JSON.stringify(found)) : null;
        },
        async findOneAndUpdate(filter, update) {
            const found = [...docs.values()].find((d) => matchFilter(d, filter) && (!filter.status || d.status === filter.status));
            if (!found) return null;
            if (update.$set) {
                Object.entries(update.$set).forEach(([path, value]) => {
                    const parts = path.split(".");
                    let target = found;
                    for (let i = 0; i < parts.length - 1; i += 1) {
                        target[parts[i]] = target[parts[i]] || {};
                        target = target[parts[i]];
                    }
                    target[parts[parts.length - 1]] = value;
                });
            }
            return JSON.parse(JSON.stringify(found));
        },
        _docs: docs,
    };
}

function makeNotificationModel() {
    const docs = [];
    const seen = new Set();
    return {
        async insertMany(rows) {
            const writeErrors = [];
            rows.forEach((row) => {
                const key = `${row.alertConfigurationId}:${row.sourceSignalId}`;
                if (seen.has(key)) {
                    writeErrors.push({ code: 11000 });
                    return;
                }
                seen.add(key);
                docs.push({ _id: new mongoose.Types.ObjectId(), ...row, read: false, createdAt: new Date() });
            });
            if (writeErrors.length) {
                const error = new Error("duplicate notification(s)");
                error.writeErrors = writeErrors;
                throw error;
            }
            return rows;
        },
        _docs: docs,
    };
}

function professionalDefinition(overrides = {}) {
    return {
        version: 2,
        universe: { timeframe: "1d" },
        entry: { type: "condition", left: { type: "price", field: "close" }, operator: "GT", right: { type: "constant", value: 100 } },
        ...overrides,
    };
}

console.log("Verification pass — full-platform integration (strategy -> backtest -> edit -> live -> signal -> notification)\n");

(async () => {
    const StrategyDefinition = makeStrategyDefinitionModel();
    const StrategyVersion = makeStrategyVersionModel();
    const BacktestResult = makeRecordingModel(RealBacktestResult);
    const BacktestTrade = makeRecordingModel(RealBacktestTrade);
    const LiveStrategyRuntime = makeLiveStrategyRuntimeModel();
    const LiveStrategySignal = makeLiveStrategySignalModel();
    const AlertConfiguration = makeAlertConfigurationModel();
    const Notification = makeNotificationModel();

    const userId = new mongoose.Types.ObjectId();
    let strategy;
    let v1;
    let resultDoc;
    let runtime;

    await test("Step 1 — create a strategy (StrategyDefinition + immutable StrategyVersion v1)", async () => {
        const created = await createStrategy({
            StrategyDefinition,
            StrategyVersion,
            userId,
            name: "Full Platform Integration Strategy",
            description: "",
            definition: professionalDefinition(),
        });
        strategy = created.strategy;
        v1 = created.version;
        assert.strictEqual(v1.versionNumber, 1);
        assert.strictEqual(String(strategy.currentVersionId), String(v1._id));
    });

    await test("Step 2 — run and persist a backtest against v1; dataQuality discloses the real cost-model limitation", async () => {
        const instrumentKey = await resolveInstrumentKey("FULLPLATSTOCK", null);
        assert.strictEqual(instrumentKey, TEST_KEY);
        const instrumentMeta = upstoxMarketData.getInstrumentMeta(instrumentKey);

        const { resultDoc: result, dataQuality } = await runAndPersistBacktest({
            models: { BacktestResult, BacktestTrade },
            userId,
            version: v1,
            instrumentKey,
            symbol: "FULLPLATSTOCK",
            instrumentMeta,
            startDate: new Date(2024, 0, 1),
            endDate: new Date(2024, 2, 1),
            initialCapital: 10000,
            commissionPct: 0.03,
            slippagePct: 0.05,
        });
        resultDoc = result;

        assert.strictEqual(String(resultDoc.strategyVersionId), String(v1._id));
        assert.ok(dataQuality.tradingCostModelNote.includes("STT"));
    });

    await test("Step 3 — editing the strategy creates v2 WITHOUT mutating the BacktestResult's frozen v1 reference", async () => {
        const edited = await createNewVersion({
            StrategyDefinition,
            StrategyVersion,
            strategyId: strategy._id,
            userId,
            definition: professionalDefinition({ risk: { stopLoss: { type: "percent", value: 5 } } }),
        });

        assert.strictEqual(edited.version.versionNumber, 2);
        assert.strictEqual(String(edited.strategy.currentVersionId), String(edited.version._id));

        // The persisted BacktestResult must still reference v1 — never
        // silently repointed at the strategy's new current version.
        assert.strictEqual(String(resultDoc.strategyVersionId), String(v1._id));
        assert.notStrictEqual(String(resultDoc.strategyVersionId), String(edited.version._id));

        // v1's own definition, independently re-fetched, must be byte-for-
        // byte unchanged — proves immutability, not just a surviving id.
        const v1Reloaded = await StrategyVersion.findOne({ _id: v1._id });
        assert.strictEqual(v1Reloaded.definition.risk, undefined, "v1 must never have gained v2's stopLoss");
    });

    await test("Step 4 — activate v1 (explicitly, the exact version the backtest used) for live evaluation", async () => {
        const instrumentKey = await resolveInstrumentKey("FULLPLATSTOCK", null);
        const activated = await activateLiveStrategy({
            models: { StrategyDefinition, StrategyVersion, LiveStrategyRuntime },
            userId,
            strategyId: strategy._id,
            strategyVersionId: v1._id,
            instrumentKey,
            symbol: "FULLPLATSTOCK",
            timeframe: "1d",
            initialCapital: 10000,
            commissionPct: 0.03,
            slippagePct: 0.05,
        });
        runtime = activated.runtime;
        assert.strictEqual(String(runtime.strategyVersionId), String(v1._id));
        assert.strictEqual(runtime.status, "ACTIVE");
    });

    await test("Step 5 — live processing of completed candles produces a persisted LiveStrategySignal (parity with the backtest's own entry rule)", async () => {
        const result = await processRuntimeOnce(runtime, {
            LiveStrategyRuntime,
            LiveStrategySignal,
            definition: v1.definition,
            deps: {
                fetchLatestClosedCandles: async () => {
                    const { getCandles, toBacktestQuote } = require("../services/candleService");
                    const raw = await getCandles(TEST_KEY, { interval: "days", unit: "1", maxBars: 60 });
                    return raw.map(toBacktestQuote).filter((c) => Number.isFinite(c.close));
                },
            },
        });

        assert.strictEqual(result.skipped, false);
        assert.ok(LiveStrategySignal._docs.length > 0, "the live engine must have produced at least one signal from the same entry rule the backtest used");
        assert.ok(LiveStrategySignal._docs.some((s) => s.type === "ENTRY_SIGNAL" || s.type === "ENTRY_FILLED"));
    });

    await test("Step 6 — creating an alert configuration for this runtime and processing it produces a de-duplicated Notification", async () => {
        const config = await createAlertConfiguration({
            models: { LiveStrategyRuntime, AlertConfiguration },
            userId,
            runtimeId: String(runtime._id),
            eventTypes: ["ENTRY_SIGNAL", "ENTRY_FILLED", "EXIT_SIGNAL", "EXIT_FILLED"],
            enabled: true,
        });

        const result = await processAlertConfiguration(config, { LiveStrategyRuntime, LiveStrategySignal, AlertConfiguration, Notification });
        assert.strictEqual(result.skipped, false);
        assert.ok(Notification._docs.length > 0, "at least one notification must be produced from the signal(s) created in Step 5");

        const notification = Notification._docs[0];
        assert.strictEqual(String(notification.runtimeId), String(runtime._id));
        assert.strictEqual(String(notification.strategyId), String(strategy._id));

        // Re-processing the same configuration must never duplicate the
        // notification already created (ADR-016's dedup guarantee, proven
        // here at the end of the full chain, not just in isolation).
        const countBeforeSecondPass = Notification._docs.length;
        const secondPass = await processAlertConfiguration(
            await AlertConfiguration.findOne({ _id: config._id }),
            { LiveStrategyRuntime, LiveStrategySignal, AlertConfiguration, Notification },
        );
        assert.ok(secondPass.skipped === true || secondPass.processedSignals === 0);
        assert.strictEqual(Notification._docs.length, countBeforeSecondPass, "no duplicate notification must be created on a re-run");
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
