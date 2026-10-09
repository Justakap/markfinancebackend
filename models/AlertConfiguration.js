const mongoose = require("mongoose");

const EVENT_TYPES = ["ENTRY_SIGNAL", "EXIT_SIGNAL", "ENTRY_FILLED", "EXIT_FILLED"];

/**
 * Workstream K — a user's notification preferences for one
 * LiveStrategyRuntime. Deliberately separate from both
 * StrategyDefinition/StrategyVersion (immutable, ADR-001) and
 * LiveStrategyRuntime (the evaluation state) — a user can reconfigure
 * which event types they want alerted on, or disable alerting entirely,
 * without that ever touching strategy evaluation or its persisted state.
 *
 * `cursor` tracks how far this configuration has processed
 * LiveStrategySignal's append-only log (ADR-016) — LiveStrategySignal
 * itself is never modified by this model; it's read-only input here,
 * same "immutable source" discipline as a backtest never rewriting its
 * own trade history.
 */
const alertConfigurationSchema = new mongoose.Schema(
    {
        userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
        runtimeId: { type: mongoose.Schema.Types.ObjectId, ref: "LiveStrategyRuntime", required: true },
        strategyId: { type: mongoose.Schema.Types.ObjectId, ref: "StrategyDefinition", required: true },

        eventTypes: {
            type: [String],
            enum: EVENT_TYPES,
            default: EVENT_TYPES,
            validate: {
                validator: (arr) => Array.isArray(arr) && arr.length > 0,
                message: "eventTypes must include at least one event type",
            },
        },

        enabled: { type: Boolean, default: true },
        status: { type: String, enum: ["ACTIVE", "ARCHIVED"], default: "ACTIVE", index: true },

        cursor: {
            lastAlertedSignalId: { type: mongoose.Schema.Types.ObjectId, default: null },
        },

        processingLockedUntil: { type: Date, default: null },
    },
    { timestamps: true },
);

// One ACTIVE alert configuration per (user, runtime) — re-configuring
// means updating the existing one, not creating a second one that would
// silently double-notify. An ARCHIVED configuration doesn't block a
// fresh one being created for the same runtime later.
alertConfigurationSchema.index(
    { userId: 1, runtimeId: 1 },
    { unique: true, partialFilterExpression: { status: "ACTIVE" } },
);
alertConfigurationSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model("AlertConfiguration", alertConfigurationSchema);
module.exports.EVENT_TYPES = EVENT_TYPES;
