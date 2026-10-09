/**
 * Workstream K — services/alertConfigurationService.js tests: ownership,
 * duplicate-active-configuration prevention, event-type validation, field
 * allowlisting on update, and archive semantics.
 */
const assert = require("assert");
const mongoose = require("mongoose");

const {
    createAlertConfiguration,
    updateAlertConfiguration,
    archiveAlertConfiguration,
} = require("../services/alertConfigurationService");

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

function makeFakeModels({ runtimes = [], configs = [] } = {}) {
    const runtimeMap = new Map(runtimes.map((r) => [String(r._id), r]));
    const configMap = new Map(configs.map((c) => [String(c._id), c]));

    const LiveStrategyRuntime = {
        async findOne(filter) {
            const found = [...runtimeMap.values()].find((r) => String(r._id) === String(filter._id) && String(r.userId) === String(filter.userId));
            return found || null;
        },
    };

    const AlertConfiguration = {
        async create(doc) {
            const existing = [...configMap.values()].find(
                (c) => c.status === "ACTIVE" && String(c.userId) === String(doc.userId) && String(c.runtimeId) === String(doc.runtimeId),
            );
            if (existing) {
                const error = new Error("duplicate");
                error.code = 11000;
                throw error;
            }
            const _id = new mongoose.Types.ObjectId();
            const toInsert = { _id, cursor: { lastAlertedSignalId: null }, processingLockedUntil: null, ...doc, createdAt: new Date() };
            configMap.set(String(_id), toInsert);
            return toInsert;
        },
        async findOneAndUpdate(filter, update) {
            const found = [...configMap.values()].find((c) => String(c._id) === String(filter._id) && String(c.userId) === String(filter.userId) && (!filter.status || c.status === filter.status));
            if (!found) return null;
            Object.assign(found, update.$set || {});
            return found;
        },
    };

    return { LiveStrategyRuntime, AlertConfiguration, runtimeMap, configMap };
}

console.log("Workstream K — alertConfigurationService\n");

(async () => {
    await test("Creating a configuration for a runtime the caller owns succeeds", async () => {
        const userId = new mongoose.Types.ObjectId();
        const runtimeId = new mongoose.Types.ObjectId();
        const strategyId = new mongoose.Types.ObjectId();
        const models = makeFakeModels({ runtimes: [{ _id: runtimeId, userId, strategyId }] });

        const config = await createAlertConfiguration({ models, userId, runtimeId: String(runtimeId), eventTypes: ["ENTRY_FILLED", "EXIT_FILLED"] });
        assert.strictEqual(String(config.runtimeId), String(runtimeId));
        assert.strictEqual(String(config.strategyId), String(strategyId));
        assert.deepStrictEqual(config.eventTypes, ["ENTRY_FILLED", "EXIT_FILLED"]);
    });

    await test("Creating a configuration for a runtime the caller does NOT own is rejected (404)", async () => {
        const ownerId = new mongoose.Types.ObjectId();
        const attackerId = new mongoose.Types.ObjectId();
        const runtimeId = new mongoose.Types.ObjectId();
        const models = makeFakeModels({ runtimes: [{ _id: runtimeId, userId: ownerId, strategyId: new mongoose.Types.ObjectId() }] });

        await assert.rejects(
            () => createAlertConfiguration({ models, userId: attackerId, runtimeId: String(runtimeId) }),
            (error) => error.statusCode === 404,
        );
    });

    await test("An unsupported eventTypes value is rejected (400) before any write", async () => {
        const userId = new mongoose.Types.ObjectId();
        const runtimeId = new mongoose.Types.ObjectId();
        const models = makeFakeModels({ runtimes: [{ _id: runtimeId, userId, strategyId: new mongoose.Types.ObjectId() }] });

        await assert.rejects(
            () => createAlertConfiguration({ models, userId, runtimeId: String(runtimeId), eventTypes: ["ENTRY_SIGNAL", "ORDER_PLACED"] }),
            (error) => error.statusCode === 400,
        );
    });

    await test("A second active configuration for the same runtime is rejected (409), not silently duplicated", async () => {
        const userId = new mongoose.Types.ObjectId();
        const runtimeId = new mongoose.Types.ObjectId();
        const models = makeFakeModels({ runtimes: [{ _id: runtimeId, userId, strategyId: new mongoose.Types.ObjectId() }] });

        await createAlertConfiguration({ models, userId, runtimeId: String(runtimeId) });
        await assert.rejects(
            () => createAlertConfiguration({ models, userId, runtimeId: String(runtimeId) }),
            (error) => error.statusCode === 409,
        );
        assert.strictEqual(models.configMap.size, 1);
    });

    await test("Updating enabled/eventTypes only ever touches those two fields (allowlist)", async () => {
        const userId = new mongoose.Types.ObjectId();
        const runtimeId = new mongoose.Types.ObjectId();
        const models = makeFakeModels({ runtimes: [{ _id: runtimeId, userId, strategyId: new mongoose.Types.ObjectId() }] });
        const config = await createAlertConfiguration({ models, userId, runtimeId: String(runtimeId) });

        const updated = await updateAlertConfiguration({ models, userId, configId: config._id, updates: { enabled: false, status: "ARCHIVED" } });
        assert.strictEqual(updated.enabled, false);
        assert.strictEqual(updated.status, "ACTIVE", "status is not in the allowlist — it must be ignored, not silently settable via update");
    });

    await test("Updating a configuration the caller does not own is rejected (404)", async () => {
        const ownerId = new mongoose.Types.ObjectId();
        const attackerId = new mongoose.Types.ObjectId();
        const runtimeId = new mongoose.Types.ObjectId();
        const models = makeFakeModels({ runtimes: [{ _id: runtimeId, userId: ownerId, strategyId: new mongoose.Types.ObjectId() }] });
        const config = await createAlertConfiguration({ models, userId: ownerId, runtimeId: String(runtimeId) });

        await assert.rejects(
            () => updateAlertConfiguration({ models, userId: attackerId, configId: config._id, updates: { enabled: false } }),
            (error) => error.statusCode === 404,
        );
    });

    await test("Archiving frees the runtime for a brand-new active configuration", async () => {
        const userId = new mongoose.Types.ObjectId();
        const runtimeId = new mongoose.Types.ObjectId();
        const models = makeFakeModels({ runtimes: [{ _id: runtimeId, userId, strategyId: new mongoose.Types.ObjectId() }] });
        const config = await createAlertConfiguration({ models, userId, runtimeId: String(runtimeId) });

        const archived = await archiveAlertConfiguration({ models, userId, configId: config._id });
        assert.strictEqual(archived.status, "ARCHIVED");
        assert.strictEqual(archived.enabled, false);

        const fresh = await createAlertConfiguration({ models, userId, runtimeId: String(runtimeId) });
        assert.ok(fresh._id);
    });

    await test("No updatable fields supplied is rejected (400)", async () => {
        const userId = new mongoose.Types.ObjectId();
        const runtimeId = new mongoose.Types.ObjectId();
        const models = makeFakeModels({ runtimes: [{ _id: runtimeId, userId, strategyId: new mongoose.Types.ObjectId() }] });
        const config = await createAlertConfiguration({ models, userId, runtimeId: String(runtimeId) });

        await assert.rejects(
            () => updateAlertConfiguration({ models, userId, configId: config._id, updates: {} }),
            (error) => error.statusCode === 400,
        );
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
