const assert = require("assert");
const mongoose = require("mongoose");

const StrategyDefinition = require("../models/StrategyDefinition");
const StrategyVersion = require("../models/StrategyVersion");
const BacktestResult = require("../models/BacktestResult");
const BacktestTrade = require("../models/BacktestTrade");
const { createStrategy, createNewVersion, getCurrentVersion } = require("../services/strategyVersionService");
const { buildExportPayload } = require("../scripts/exportLegacyStrategies");

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        passed += 1;
        console.log(`  ✓ ${name}`);
    } catch (error) {
        failed += 1;
        console.error(`  ✗ ${name}`);
        console.error(`    ${error.message}`);
    }
}

async function asyncTest(name, fn) {
    try {
        await fn();
        passed += 1;
        console.log(`  ✓ ${name}`);
    } catch (error) {
        failed += 1;
        console.error(`  ✗ ${name}`);
        console.error(`    ${error.message}`);
    }
}

// --- Schema-level tests (no live DB connection needed — Mongoose runs
// validators/index declarations purely in-memory) ---

console.log("Phase A — StrategyDefinition / StrategyVersion / BacktestResult / BacktestTrade\n");

test("StrategyDefinition requires userId and name", () => {
    const doc = new StrategyDefinition({});
    const error = doc.validateSync();
    assert.ok(error);
    assert.ok(error.errors.userId);
    assert.ok(error.errors.name);
});

test("StrategyDefinition defaults: status ACTIVE, currentVersionId null", () => {
    const doc = new StrategyDefinition({
        userId: new mongoose.Types.ObjectId(),
        name: "Test",
    });
    assert.strictEqual(doc.status, "ACTIVE");
    assert.strictEqual(doc.currentVersionId, null);
});

test("StrategyDefinition rejects an invalid status", () => {
    const doc = new StrategyDefinition({
        userId: new mongoose.Types.ObjectId(),
        name: "Test",
        status: "DELETED",
    });
    const error = doc.validateSync();
    assert.ok(error?.errors?.status);
});

test("StrategyVersion requires strategyId, versionNumber, definition", () => {
    const doc = new StrategyVersion({});
    const error = doc.validateSync();
    assert.ok(error);
    assert.ok(error.errors.strategyId);
    assert.ok(error.errors.versionNumber);
    assert.ok(error.errors.definition);
});

test("StrategyVersion.definition is marked immutable", () => {
    const path = StrategyVersion.schema.path("definition");
    assert.strictEqual(path.options.immutable, true);
});

test("StrategyVersion has a unique compound index on {strategyId, versionNumber}", () => {
    const indexes = StrategyVersion.schema.indexes();
    const found = indexes.find(
        ([fields]) => fields.strategyId === 1 && fields.versionNumber === 1,
    );
    assert.ok(found, "expected a {strategyId:1, versionNumber:1} index");
    assert.strictEqual(found[1].unique, true);
});

test("BacktestResult requires strategyVersionId, instrumentKey, symbol, timeframe, dateRange, initialCapital", () => {
    const doc = new BacktestResult({});
    const error = doc.validateSync();
    assert.ok(error);
    ["strategyVersionId", "instrumentKey", "symbol", "timeframe", "initialCapital"].forEach((field) => {
        assert.ok(error.errors[field], `expected ${field} to be required`);
    });
});

test("BacktestResult has a {userId, createdAt} compound index", () => {
    const indexes = BacktestResult.schema.indexes();
    const found = indexes.find(([fields]) => fields.userId === 1 && fields.createdAt === -1);
    assert.ok(found, "expected a {userId:1, createdAt:-1} index");
});

test("BacktestTrade requires core trade fields", () => {
    const doc = new BacktestTrade({});
    const error = doc.validateSync();
    assert.ok(error);
    ["backtestResultId", "quantity", "entryDate", "exitDate", "entryPrice", "exitPrice", "grossPnl", "netPnl", "returnPct"].forEach(
        (field) => assert.ok(error.errors[field], `expected ${field} to be required`),
    );
});

test("BacktestTrade has a {backtestResultId, entryDate} compound index", () => {
    const indexes = BacktestTrade.schema.indexes();
    const found = indexes.find(([fields]) => fields.backtestResultId === 1 && fields.entryDate === 1);
    assert.ok(found, "expected a {backtestResultId:1, entryDate:1} index");
});

test("BacktestTrade rejects an invalid side", () => {
    const doc = new BacktestTrade({
        backtestResultId: new mongoose.Types.ObjectId(),
        quantity: 10,
        entryDate: new Date(),
        exitDate: new Date(),
        entryPrice: 100,
        exitPrice: 110,
        grossPnl: 100,
        netPnl: 95,
        returnPct: 10,
        side: "BOTH",
    });
    const error = doc.validateSync();
    assert.ok(error?.errors?.side);
});

// --- strategyVersionService tests, using lightweight in-memory fakes for
// the Mongoose models (dependency-injected, consistent with how this
// codebase's route factories already take injected deps) ---

function makeFakeModels() {
    const strategies = new Map();
    const versions = [];
    let strategyIdCounter = 1;
    let versionIdCounter = 1;

    const FakeStrategyDefinition = {
        async create({ userId, name, description }) {
            const doc = {
                _id: `strategy-${strategyIdCounter++}`,
                userId,
                name,
                description,
                currentVersionId: null,
                async save() {
                    strategies.set(this._id, this);
                },
            };
            strategies.set(doc._id, doc);
            return doc;
        },
        async findOne({ _id, userId }) {
            const doc = strategies.get(_id);
            return doc && doc.userId === userId ? doc : null;
        },
    };

    const FakeStrategyVersion = {
        async create({ strategyId, versionNumber, definition }) {
            const doc = { _id: `version-${versionIdCounter++}`, strategyId, versionNumber, definition };
            versions.push(doc);
            return doc;
        },
        findOne({ strategyId }) {
            const matches = versions.filter((v) => v.strategyId === strategyId);
            return {
                sort() {
                    matches.sort((a, b) => b.versionNumber - a.versionNumber);
                    return Promise.resolve(matches[0] || null);
                },
            };
        },
        findById(id) {
            return Promise.resolve(versions.find((v) => v._id === id) || null);
        },
    };

    return { FakeStrategyDefinition, FakeStrategyVersion, strategies, versions };
}

(async () => {
    await asyncTest("createStrategy creates a strategy + version 1 and links currentVersionId", async () => {
        const { FakeStrategyDefinition, FakeStrategyVersion } = makeFakeModels();
        const { strategy, version } = await createStrategy({
            StrategyDefinition: FakeStrategyDefinition,
            StrategyVersion: FakeStrategyVersion,
            userId: "user-1",
            name: "Momentum",
            definition: { version: 2, entry: {} },
        });

        assert.strictEqual(version.versionNumber, 1);
        assert.strictEqual(strategy.currentVersionId, version._id);
    });

    await asyncTest("createNewVersion increments versionNumber and repoints currentVersionId, without mutating v1", async () => {
        const { FakeStrategyDefinition, FakeStrategyVersion, versions } = makeFakeModels();
        const { strategy, version: v1 } = await createStrategy({
            StrategyDefinition: FakeStrategyDefinition,
            StrategyVersion: FakeStrategyVersion,
            userId: "user-1",
            name: "Momentum",
            definition: { version: 2, entry: { rule: "A" } },
        });

        const { version: v2 } = await createNewVersion({
            StrategyDefinition: FakeStrategyDefinition,
            StrategyVersion: FakeStrategyVersion,
            strategyId: strategy._id,
            userId: "user-1",
            definition: { version: 2, entry: { rule: "B" } },
        });

        assert.strictEqual(v2.versionNumber, 2);
        assert.strictEqual(strategy.currentVersionId, v2._id);

        // v1 is untouched — this is the crux of ADR-001.
        const storedV1 = versions.find((v) => v._id === v1._id);
        assert.deepStrictEqual(storedV1.definition, { version: 2, entry: { rule: "A" } });
    });

    await asyncTest("createNewVersion refuses to act on another user's strategy", async () => {
        const { FakeStrategyDefinition, FakeStrategyVersion } = makeFakeModels();
        const { strategy } = await createStrategy({
            StrategyDefinition: FakeStrategyDefinition,
            StrategyVersion: FakeStrategyVersion,
            userId: "user-1",
            name: "Momentum",
            definition: { version: 2 },
        });

        const result = await createNewVersion({
            StrategyDefinition: FakeStrategyDefinition,
            StrategyVersion: FakeStrategyVersion,
            strategyId: strategy._id,
            userId: "someone-else",
            definition: { version: 2, entry: { rule: "hijacked" } },
        });

        assert.strictEqual(result, null);
    });

    await asyncTest("getCurrentVersion resolves the version currentVersionId points at", async () => {
        const { FakeStrategyDefinition, FakeStrategyVersion } = makeFakeModels();
        const { strategy, version } = await createStrategy({
            StrategyDefinition: FakeStrategyDefinition,
            StrategyVersion: FakeStrategyVersion,
            userId: "user-1",
            name: "Momentum",
            definition: { version: 2 },
        });

        const current = await getCurrentVersion({
            StrategyDefinition: FakeStrategyDefinition,
            StrategyVersion: FakeStrategyVersion,
            strategyId: strategy._id,
            userId: "user-1",
        });

        assert.strictEqual(current._id, version._id);
    });

    await asyncTest("getCurrentVersion returns null for an unknown strategy", async () => {
        const { FakeStrategyDefinition, FakeStrategyVersion } = makeFakeModels();
        const current = await getCurrentVersion({
            StrategyDefinition: FakeStrategyDefinition,
            StrategyVersion: FakeStrategyVersion,
            strategyId: "does-not-exist",
            userId: "user-1",
        });
        assert.strictEqual(current, null);
    });

    // --- Legacy export payload shaping (pure, DB-free) ---

    test("buildExportPayload groups backtests under their owning strategy", () => {
        const strategies = [{ _id: "s1", name: "A" }, { _id: "s2", name: "B" }];
        const backtests = [
            { _id: "bt1", strategyId: "s1" },
            { _id: "bt2", strategyId: "s1" },
            { _id: "bt3", strategyId: "s2" },
        ];
        const payload = buildExportPayload(strategies, backtests, { now: () => new Date("2026-01-01T00:00:00Z") });

        assert.strictEqual(payload.strategyCount, 2);
        assert.strictEqual(payload.backtestCount, 3);
        assert.strictEqual(payload.strategies[0].backtests.length, 2);
        assert.strictEqual(payload.strategies[1].backtests.length, 1);
        assert.strictEqual(payload.exportedAt, "2026-01-01T00:00:00.000Z");
    });

    test("buildExportPayload handles a strategy with no backtests", () => {
        const payload = buildExportPayload([{ _id: "s1" }], []);
        assert.deepStrictEqual(payload.strategies[0].backtests, []);
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
