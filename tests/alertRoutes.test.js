/**
 * Workstream K — route-level tests for /api/v2/alert-configurations/* and
 * /api/v2/notifications/*. Invokes the real Express handlers against the
 * real alertConfigurationService functions and in-memory fake models (same
 * technique as tests/liveStrategyRoutes.test.js) — no live MongoDB.
 */
const assert = require("assert");
const mongoose = require("mongoose");

const { createAlertRoutes } = require("../routes/alertRoutes");
const { createAlertConfiguration, updateAlertConfiguration, archiveAlertConfiguration } = require("../services/alertConfigurationService");
const { requireAuth } = require("../middleware/auth");
const { validateObjectId } = require("../middleware/validateObjectId");

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

function fakeRes() {
    return {
        statusCode: null,
        body: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(payload) {
            if (this.statusCode === null) this.statusCode = 200;
            this.body = payload;
            return this;
        },
    };
}

function finalHandlerFor(router, method, path) {
    const layer = router.stack.find((l) => l.route?.path === path && l.route.methods[method]);
    return layer.route.stack.at(-1).handle;
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

function matchBasic(doc, filter = {}) {
    return Object.entries(filter).every(([key, value]) => {
        if (key === "_id" || key === "userId" || key === "runtimeId") return String(doc[key]) === String(value);
        return doc[key] === value;
    });
}

function makeModels() {
    const runtimes = new Map();
    const configs = new Map();
    const notifications = new Map();

    const LiveStrategyRuntime = {
        async findOne(filter) {
            return [...runtimes.values()].find((r) => matchBasic(r, filter)) || null;
        },
    };

    const AlertConfiguration = {
        async create(doc) {
            const existing = [...configs.values()].find((c) => c.status === "ACTIVE" && String(c.userId) === String(doc.userId) && String(c.runtimeId) === String(doc.runtimeId));
            if (existing) {
                const error = new Error("dup");
                error.code = 11000;
                throw error;
            }
            const _id = new mongoose.Types.ObjectId();
            const toInsert = { _id, cursor: { lastAlertedSignalId: null }, processingLockedUntil: null, ...doc, createdAt: new Date(), updatedAt: new Date() };
            configs.set(String(_id), toInsert);
            return toInsert;
        },
        async findOneAndUpdate(filter, update) {
            const found = [...configs.values()].find((c) => matchBasic(c, filter) && (!filter.status || c.status === filter.status));
            if (!found) return null;
            Object.assign(found, update.$set || {});
            return found;
        },
        find(filter = {}) {
            return makeChainable([...configs.values()].filter((c) => matchBasic(c, filter) && (!filter.status || c.status === filter.status)));
        },
        async countDocuments(filter = {}) {
            return [...configs.values()].filter((c) => matchBasic(c, filter)).length;
        },
    };

    const Notification = {
        find(filter = {}) {
            return makeChainable(
                [...notifications.values()].filter((n) => {
                    if (!matchBasic(n, { userId: filter.userId })) return false;
                    if (filter.read !== undefined && n.read !== filter.read) return false;
                    return true;
                }),
            );
        },
        async countDocuments(filter = {}) {
            return [...notifications.values()].filter((n) => matchBasic(n, { userId: filter.userId }) && (filter.read === undefined || n.read === filter.read)).length;
        },
        async findOneAndUpdate(filter, update) {
            const found = [...notifications.values()].find((n) => matchBasic(n, filter));
            if (!found) return null;
            Object.assign(found, update.$set || {});
            return found;
        },
        async updateMany(filter, update) {
            let modifiedCount = 0;
            notifications.forEach((n) => {
                if (matchBasic(n, { userId: filter.userId }) && (filter.read === undefined || n.read === filter.read)) {
                    Object.assign(n, update.$set || {});
                    modifiedCount += 1;
                }
            });
            return { modifiedCount };
        },
    };

    return { runtimes, configs, notifications, LiveStrategyRuntime, AlertConfiguration, Notification };
}

function router(models) {
    return createAlertRoutes({
        LiveStrategyRuntime: models.LiveStrategyRuntime,
        AlertConfiguration: models.AlertConfiguration,
        Notification: models.Notification,
        requireAuth,
        validateObjectId,
        createAlertConfiguration,
        updateAlertConfiguration,
        archiveAlertConfiguration,
    });
}

console.log("Workstream K — /api/v2/alert-configurations and /api/v2/notifications route tests\n");

(async () => {
    await test("Creating an alert configuration for an owned runtime succeeds", async () => {
        const models = makeModels();
        const userId = new mongoose.Types.ObjectId();
        const runtimeId = new mongoose.Types.ObjectId();
        models.runtimes.set(String(runtimeId), { _id: runtimeId, userId, strategyId: new mongoose.Types.ObjectId() });

        const r = router(models);
        const handle = finalHandlerFor(r, "post", "/v2/alert-configurations");
        const req = { user: { mongoId: userId }, body: { runtimeId: String(runtimeId), eventTypes: ["EXIT_FILLED"] } };
        const res = fakeRes();
        await handle(req, res);

        assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
        assert.deepStrictEqual(res.body.configuration.eventTypes, ["EXIT_FILLED"]);
    });

    await test("Creating an alert configuration without a runtimeId is rejected (400)", async () => {
        const models = makeModels();
        const r = router(models);
        const handle = finalHandlerFor(r, "post", "/v2/alert-configurations");
        const req = { user: { mongoId: new mongoose.Types.ObjectId() }, body: {} };
        const res = fakeRes();
        await handle(req, res);
        assert.strictEqual(res.statusCode, 400);
    });

    await test("Creating an alert configuration against a runtime owned by someone else is rejected (404)", async () => {
        const models = makeModels();
        const ownerId = new mongoose.Types.ObjectId();
        const attackerId = new mongoose.Types.ObjectId();
        const runtimeId = new mongoose.Types.ObjectId();
        models.runtimes.set(String(runtimeId), { _id: runtimeId, userId: ownerId, strategyId: new mongoose.Types.ObjectId() });

        const r = router(models);
        const handle = finalHandlerFor(r, "post", "/v2/alert-configurations");
        const req = { user: { mongoId: attackerId }, body: { runtimeId: String(runtimeId) } };
        const res = fakeRes();
        await handle(req, res);
        assert.strictEqual(res.statusCode, 404);
    });

    await test("Listing alert configurations only returns the caller's own", async () => {
        const models = makeModels();
        const userId = new mongoose.Types.ObjectId();
        const otherId = new mongoose.Types.ObjectId();
        models.configs.set("a", { _id: new mongoose.Types.ObjectId(), userId, status: "ACTIVE", eventTypes: [], runtimeId: new mongoose.Types.ObjectId(), strategyId: new mongoose.Types.ObjectId() });
        models.configs.set("b", { _id: new mongoose.Types.ObjectId(), userId: otherId, status: "ACTIVE", eventTypes: [], runtimeId: new mongoose.Types.ObjectId(), strategyId: new mongoose.Types.ObjectId() });

        const r = router(models);
        const handle = finalHandlerFor(r, "get", "/v2/alert-configurations");
        const req = { user: { mongoId: userId }, query: {} };
        const res = fakeRes();
        await handle(req, res);
        assert.strictEqual(res.body.items.length, 1);
    });

    await test("Listing alert configurations can be filtered to a single runtime (Workstream L addition)", async () => {
        const models = makeModels();
        const userId = new mongoose.Types.ObjectId();
        const runtimeA = new mongoose.Types.ObjectId();
        const runtimeB = new mongoose.Types.ObjectId();
        models.configs.set("a", { _id: new mongoose.Types.ObjectId(), userId, status: "ACTIVE", eventTypes: [], runtimeId: runtimeA, strategyId: new mongoose.Types.ObjectId() });
        models.configs.set("b", { _id: new mongoose.Types.ObjectId(), userId, status: "ACTIVE", eventTypes: [], runtimeId: runtimeB, strategyId: new mongoose.Types.ObjectId() });

        const r = router(models);
        const handle = finalHandlerFor(r, "get", "/v2/alert-configurations");

        const filtered = fakeRes();
        await handle({ user: { mongoId: userId }, query: { runtimeId: String(runtimeA) } }, filtered);
        assert.strictEqual(filtered.body.items.length, 1);
        assert.strictEqual(String(filtered.body.items[0].runtimeId), String(runtimeA));

        const invalidId = fakeRes();
        await handle({ user: { mongoId: userId }, query: { runtimeId: "not-an-object-id" } }, invalidId);
        assert.strictEqual(invalidId.body.items.length, 2, "an invalid runtimeId is silently ignored, not rejected or crashed on");
    });

    await test("Deleting (archiving) another user's configuration is rejected (404)", async () => {
        const models = makeModels();
        const ownerId = new mongoose.Types.ObjectId();
        const attackerId = new mongoose.Types.ObjectId();
        const configId = new mongoose.Types.ObjectId();
        models.configs.set(String(configId), { _id: configId, userId: ownerId, status: "ACTIVE", eventTypes: [] });

        const r = router(models);
        const handle = finalHandlerFor(r, "delete", "/v2/alert-configurations/:configId");
        const req = { user: { mongoId: attackerId }, params: { configId: String(configId) } };
        const res = fakeRes();
        await handle(req, res);
        assert.strictEqual(res.statusCode, 404);
    });

    await test("Listing notifications is scoped to the caller and supports a read/unread filter", async () => {
        const models = makeModels();
        const userId = new mongoose.Types.ObjectId();
        const otherId = new mongoose.Types.ObjectId();
        models.notifications.set("a", { _id: new mongoose.Types.ObjectId(), userId, read: false, type: "ENTRY_SIGNAL", runtimeId: new mongoose.Types.ObjectId(), strategyId: new mongoose.Types.ObjectId(), sourceSignalId: new mongoose.Types.ObjectId(), title: "t", body: "b", isFill: false, createdAt: new Date() });
        models.notifications.set("b", { _id: new mongoose.Types.ObjectId(), userId, read: true, type: "EXIT_FILLED", runtimeId: new mongoose.Types.ObjectId(), strategyId: new mongoose.Types.ObjectId(), sourceSignalId: new mongoose.Types.ObjectId(), title: "t2", body: "b2", isFill: true, createdAt: new Date() });
        models.notifications.set("c", { _id: new mongoose.Types.ObjectId(), userId: otherId, read: false, type: "ENTRY_SIGNAL", runtimeId: new mongoose.Types.ObjectId(), strategyId: new mongoose.Types.ObjectId(), sourceSignalId: new mongoose.Types.ObjectId(), title: "t3", body: "b3", isFill: false, createdAt: new Date() });

        const r = router(models);
        const handle = finalHandlerFor(r, "get", "/v2/notifications");

        const allRes = fakeRes();
        await handle({ user: { mongoId: userId }, query: {} }, allRes);
        assert.strictEqual(allRes.body.items.length, 2);

        const unreadRes = fakeRes();
        await handle({ user: { mongoId: userId }, query: { read: "false" } }, unreadRes);
        assert.strictEqual(unreadRes.body.items.length, 1);
        assert.strictEqual(unreadRes.body.items[0].read, false);
    });

    await test("Unread count reflects only the caller's unread notifications", async () => {
        const models = makeModels();
        const userId = new mongoose.Types.ObjectId();
        models.notifications.set("a", { _id: new mongoose.Types.ObjectId(), userId, read: false, type: "ENTRY_SIGNAL", runtimeId: new mongoose.Types.ObjectId(), strategyId: new mongoose.Types.ObjectId(), sourceSignalId: new mongoose.Types.ObjectId(), title: "t", body: "b", isFill: false, createdAt: new Date() });
        models.notifications.set("b", { _id: new mongoose.Types.ObjectId(), userId, read: true, type: "EXIT_FILLED", runtimeId: new mongoose.Types.ObjectId(), strategyId: new mongoose.Types.ObjectId(), sourceSignalId: new mongoose.Types.ObjectId(), title: "t2", body: "b2", isFill: true, createdAt: new Date() });

        const r = router(models);
        const handle = finalHandlerFor(r, "get", "/v2/notifications/unread-count");
        const res = fakeRes();
        await handle({ user: { mongoId: userId } }, res);
        assert.strictEqual(res.body.count, 1);
    });

    await test("Marking a notification read transitions it, and is rejected for another user's notification (404)", async () => {
        const models = makeModels();
        const ownerId = new mongoose.Types.ObjectId();
        const attackerId = new mongoose.Types.ObjectId();
        const notifId = new mongoose.Types.ObjectId();
        models.notifications.set(String(notifId), { _id: notifId, userId: ownerId, read: false, type: "ENTRY_SIGNAL", runtimeId: new mongoose.Types.ObjectId(), strategyId: new mongoose.Types.ObjectId(), sourceSignalId: new mongoose.Types.ObjectId(), title: "t", body: "b", isFill: false, createdAt: new Date() });

        const r = router(models);
        const handle = finalHandlerFor(r, "put", "/v2/notifications/:notificationId/read");

        const attackerRes = fakeRes();
        await handle({ user: { mongoId: attackerId }, params: { notificationId: String(notifId) } }, attackerRes);
        assert.strictEqual(attackerRes.statusCode, 404);
        assert.strictEqual(models.notifications.get(String(notifId)).read, false);

        const ownerRes = fakeRes();
        await handle({ user: { mongoId: ownerId }, params: { notificationId: String(notifId) } }, ownerRes);
        assert.strictEqual(ownerRes.statusCode, 200);
        assert.strictEqual(ownerRes.body.notification.read, true);
    });

    await test("Mark-all-read only affects the caller's own unread notifications", async () => {
        const models = makeModels();
        const userId = new mongoose.Types.ObjectId();
        const otherId = new mongoose.Types.ObjectId();
        models.notifications.set("a", { _id: new mongoose.Types.ObjectId(), userId, read: false, type: "ENTRY_SIGNAL", runtimeId: new mongoose.Types.ObjectId(), strategyId: new mongoose.Types.ObjectId(), sourceSignalId: new mongoose.Types.ObjectId(), title: "t", body: "b", isFill: false, createdAt: new Date() });
        models.notifications.set("b", { _id: new mongoose.Types.ObjectId(), userId: otherId, read: false, type: "ENTRY_SIGNAL", runtimeId: new mongoose.Types.ObjectId(), strategyId: new mongoose.Types.ObjectId(), sourceSignalId: new mongoose.Types.ObjectId(), title: "t2", body: "b2", isFill: false, createdAt: new Date() });

        const r = router(models);
        const handle = finalHandlerFor(r, "post", "/v2/notifications/mark-all-read");
        const res = fakeRes();
        await handle({ user: { mongoId: userId } }, res);

        assert.strictEqual(res.body.updated, 1);
        assert.strictEqual(models.notifications.get("a").read, true);
        assert.strictEqual(models.notifications.get("b").read, false);
    });

    await test("requireAuth is wired on every alert/notification route", () => {
        const models = makeModels();
        const r = router(models);
        [
            "/v2/alert-configurations",
            "/v2/alert-configurations/:configId",
            "/v2/notifications",
            "/v2/notifications/unread-count",
            "/v2/notifications/:notificationId/read",
            "/v2/notifications/mark-all-read",
        ].forEach((path) => {
            const layers = r.stack.filter((l) => l.route?.path === path);
            assert.ok(layers.length > 0, `no route registered for ${path}`);
            layers.forEach((layer) => {
                assert.ok(layer.route.stack.some((l) => l.handle === requireAuth), `requireAuth missing on ${path}`);
            });
        });
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
