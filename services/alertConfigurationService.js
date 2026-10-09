/**
 * Workstream K — CRUD orchestration for AlertConfiguration, kept separate
 * from routes/alertRoutes.js so the route stays thin (same convention as
 * liveStrategyService.js vs. liveStrategyRoutes.js).
 */

const { EVENT_TYPES } = require("../models/AlertConfiguration");

function makeError(statusCode, message) {
    const error = new Error(message);
    error.statusCode = statusCode;
    error.clientMessage = message;
    return error;
}

function validateEventTypes(eventTypes) {
    if (eventTypes === undefined) return null;
    if (!Array.isArray(eventTypes) || eventTypes.length === 0) {
        return "eventTypes must be a non-empty array";
    }
    const invalid = eventTypes.filter((t) => !EVENT_TYPES.includes(t));
    if (invalid.length) {
        return `eventTypes contains unsupported value(s): ${invalid.join(", ")}`;
    }
    return null;
}

/**
 * Ownership of `runtimeId` is verified against the SAME user before a
 * configuration can ever reference it — a user may only be notified about
 * their own live strategy runtimes, never someone else's (milestone §7).
 */
async function createAlertConfiguration({
    models: { LiveStrategyRuntime, AlertConfiguration },
    userId,
    runtimeId,
    eventTypes,
    enabled = true,
}) {
    const runtime = await LiveStrategyRuntime.findOne({ _id: runtimeId, userId });
    if (!runtime) {
        throw makeError(404, "Live strategy runtime not found");
    }

    const eventTypesError = validateEventTypes(eventTypes);
    if (eventTypesError) {
        throw makeError(400, eventTypesError);
    }

    try {
        const config = await AlertConfiguration.create({
            userId,
            runtimeId: runtime._id,
            strategyId: runtime.strategyId,
            eventTypes: eventTypes || EVENT_TYPES,
            enabled: !!enabled,
            status: "ACTIVE",
        });
        return config;
    } catch (error) {
        if (error.code === 11000) {
            throw makeError(409, "An alert configuration already exists for this runtime. Update it instead of creating another.");
        }
        throw error;
    }
}

/** `updates` may include `enabled` and/or `eventTypes` only — a field
 *  allowlist, never a raw req.body pass-through (same discipline as
 *  every other route in this codebase since the Phase 2.0 hardening pass). */
async function updateAlertConfiguration({
    models: { AlertConfiguration },
    userId,
    configId,
    updates,
}) {
    const patch = {};
    if (updates.enabled !== undefined) patch.enabled = !!updates.enabled;
    if (updates.eventTypes !== undefined) {
        const eventTypesError = validateEventTypes(updates.eventTypes);
        if (eventTypesError) throw makeError(400, eventTypesError);
        patch.eventTypes = updates.eventTypes;
    }

    if (Object.keys(patch).length === 0) {
        throw makeError(400, "No updatable fields supplied (enabled, eventTypes)");
    }

    const config = await AlertConfiguration.findOneAndUpdate(
        { _id: configId, userId, status: "ACTIVE" },
        { $set: patch },
        { returnDocument: "after" },
    );
    if (!config) {
        throw makeError(404, "Alert configuration not found");
    }
    return config;
}

/** Soft-delete ("archive"), never a hard delete — matches
 *  StrategyDefinition's own ACTIVE/ARCHIVED convention, and frees the
 *  unique {userId, runtimeId} slot for a future fresh configuration on
 *  the same runtime (the partial unique index only covers status:ACTIVE). */
async function archiveAlertConfiguration({ models: { AlertConfiguration }, userId, configId }) {
    const config = await AlertConfiguration.findOneAndUpdate(
        { _id: configId, userId, status: "ACTIVE" },
        { $set: { status: "ARCHIVED", enabled: false } },
        { returnDocument: "after" },
    );
    if (!config) {
        throw makeError(404, "Alert configuration not found");
    }
    return config;
}

module.exports = {
    createAlertConfiguration,
    updateAlertConfiguration,
    archiveAlertConfiguration,
    validateEventTypes,
    makeError,
};
