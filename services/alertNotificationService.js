/**
 * Workstream K — consumes LiveStrategySignal (Workstream J's append-only
 * signal/fill log) as a durable outbox and produces persisted, de-duplicated
 * Notification documents. Zero changes to liveStrategyOrchestrator.js or
 * liveSignalEngine.js — this reads LiveStrategySignal, it never writes to
 * it, and strategy evaluation is completely unaware this consumer exists.
 *
 * CONCURRENCY / DEDUP (mirrors ADR-015's lock pattern, with one
 * deliberate improvement — see ADR-016 in .claude/state/DECISIONS.md):
 * each poll of a configuration first claims a short-TTL DB lock exactly
 * like services/liveStrategyOrchestrator.js's runtime lock. Unlike that
 * lock, the correctness guarantee here does NOT depend on the lock alone
 * — Notification's unique index on {alertConfigurationId, sourceSignalId}
 * means even a failed lock claim, a crash mid-batch, or two processes
 * racing past the lock can never produce two user-visible notifications
 * for the same source signal: every insert attempt beyond the first for
 * the same pair fails with a duplicate-key error, which this service
 * treats as "already delivered," not a real failure. This is why
 * notifications are inserted BEFORE the cursor commits (the opposite
 * order from ADR-015's engineState-then-log) — a crash between the two
 * here just means the next run safely re-attempts the same batch.
 */

const { buildNotificationContent } = require("./alertContentBuilder");

const LOCK_DURATION_MS = Number(process.env.ALERT_ENGINE_LOCK_MS || 30_000);
const BATCH_SIZE = Number(process.env.ALERT_ENGINE_BATCH_SIZE || 200);

function isDuplicateKeyError(error) {
    if (error?.code === 11000) return true;
    // Mongoose bulk-write errors surface duplicate keys inside
    // `writeErrors`, each with its own `.code`.
    if (Array.isArray(error?.writeErrors)) {
        return error.writeErrors.every((e) => e.code === 11000 || e.err?.code === 11000);
    }
    return false;
}

/**
 * Processes exactly one AlertConfiguration's pending backlog of signals.
 * Dependency-injected (`deps.now`) for deterministic tests, same
 * convention as liveStrategyOrchestrator.js.
 */
async function processAlertConfiguration(config, { LiveStrategyRuntime, LiveStrategySignal, AlertConfiguration, Notification, deps = {} }) {
    const nowMs = deps.now ? deps.now() : Date.now();
    const lockUntil = new Date(nowMs + LOCK_DURATION_MS);

    const claimed = await AlertConfiguration.findOneAndUpdate(
        {
            _id: config._id,
            status: "ACTIVE",
            enabled: true,
            $or: [{ processingLockedUntil: null }, { processingLockedUntil: { $lte: new Date(nowMs) } }],
        },
        { $set: { processingLockedUntil: lockUntil } },
        { new: true },
    );

    if (!claimed) {
        return { skipped: true, reason: "locked-or-inactive" };
    }

    try {
        const runtime = await LiveStrategyRuntime.findOne({ _id: claimed.runtimeId });
        if (!runtime) {
            await AlertConfiguration.findOneAndUpdate({ _id: claimed._id }, { $set: { processingLockedUntil: null } });
            return { skipped: true, reason: "runtime-not-found" };
        }

        const signalFilter = {
            runtimeId: claimed.runtimeId,
            type: { $in: claimed.eventTypes },
        };
        if (claimed.cursor?.lastAlertedSignalId) {
            signalFilter._id = { $gt: claimed.cursor.lastAlertedSignalId };
        }

        const newSignals = await LiveStrategySignal.find(signalFilter).sort({ _id: 1 }).limit(BATCH_SIZE);

        if (!newSignals.length) {
            await AlertConfiguration.findOneAndUpdate({ _id: claimed._id }, { $set: { processingLockedUntil: null } });
            return { skipped: true, reason: "no-new-signals" };
        }

        const docs = newSignals.map((signal) => {
            const content = buildNotificationContent({ signal, runtime, strategyName: deps.strategyName });
            return {
                userId: claimed.userId,
                alertConfigurationId: claimed._id,
                runtimeId: claimed.runtimeId,
                strategyId: claimed.strategyId,
                sourceSignalId: signal._id,
                type: signal.type,
                isFill: content.isFill,
                title: content.title,
                body: content.body,
            };
        });

        // `ordered: false` so one duplicate (already-delivered) row never
        // blocks the rest of the batch from being inserted.
        try {
            await Notification.insertMany(docs, { ordered: false });
        } catch (error) {
            if (!isDuplicateKeyError(error)) throw error;
        }

        const lastSignalId = newSignals[newSignals.length - 1]._id;
        await AlertConfiguration.findOneAndUpdate(
            { _id: claimed._id },
            { $set: { "cursor.lastAlertedSignalId": lastSignalId, processingLockedUntil: null } },
        );

        return { skipped: false, processedSignals: newSignals.length };
    } catch (error) {
        await AlertConfiguration.findOneAndUpdate({ _id: claimed._id }, { $set: { processingLockedUntil: null } }).catch(() => {});
        throw error;
    }
}

async function pollAllActiveAlertConfigurations({ LiveStrategyRuntime, LiveStrategySignal, AlertConfiguration, Notification, deps = {} }) {
    const configs = await AlertConfiguration.find({ status: "ACTIVE", enabled: true });
    const results = [];

    for (const config of configs) {
        try {
            // eslint-disable-next-line no-await-in-loop -- one configuration's
            // signal read already goes through the shared DB; no correctness
            // benefit to racing configurations against each other here.
            const result = await processAlertConfiguration(config, { LiveStrategyRuntime, LiveStrategySignal, AlertConfiguration, Notification, deps });
            results.push({ configId: config._id, ...result });
        } catch (error) {
            console.error(`Alert configuration ${config._id} processing error:`, error.message);
            results.push({ configId: config._id, skipped: true, reason: "error", error: error.message });
        }
    }

    return results;
}

let pollTimer = null;

function startAlertProcessingPolling(models, intervalMs = Number(process.env.ALERT_ENGINE_POLL_MS || 10_000)) {
    if (pollTimer) return;
    pollTimer = setInterval(() => {
        pollAllActiveAlertConfigurations(models).catch((error) => console.error("Alert poll cycle error:", error.message));
    }, intervalMs);
    pollTimer.unref?.();
}

function stopAlertProcessingPolling() {
    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }
}

module.exports = {
    processAlertConfiguration,
    pollAllActiveAlertConfigurations,
    startAlertProcessingPolling,
    stopAlertProcessingPolling,
    LOCK_DURATION_MS,
    BATCH_SIZE,
};
