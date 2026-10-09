const mongoose = require("mongoose");

/**
 * Workstream K — one persisted, user-visible in-app notification, derived
 * from exactly one LiveStrategySignal ("the source event"). Never a second
 * kind of event generated to trigger a notification — `sourceSignalId` is
 * the LiveStrategySignal._id this notification is ABOUT, and the unique
 * index below on {alertConfigurationId, sourceSignalId} is the entire
 * duplicate-prevention guarantee: no matter how many times the alert
 * processor runs, crashes, retries, or races another worker, at most one
 * Notification document can ever exist for a given (configuration, source
 * event) pair — the second insert attempt fails with a duplicate-key error
 * that the processor treats as "already delivered," not a real error.
 *
 * `isFill` makes the signal-vs-simulated-fill distinction an explicit,
 * queryable field rather than something inferred from `type` by every
 * consumer — the milestone's #2 requirement ("distinguish a strategy
 * signal from a simulated fill in both the notification content and
 * event metadata").
 */
const notificationSchema = new mongoose.Schema(
    {
        userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
        alertConfigurationId: { type: mongoose.Schema.Types.ObjectId, ref: "AlertConfiguration", required: true },
        runtimeId: { type: mongoose.Schema.Types.ObjectId, ref: "LiveStrategyRuntime", required: true },
        strategyId: { type: mongoose.Schema.Types.ObjectId, ref: "StrategyDefinition", required: true },
        sourceSignalId: { type: mongoose.Schema.Types.ObjectId, ref: "LiveStrategySignal", required: true },

        type: {
            type: String,
            enum: ["ENTRY_SIGNAL", "EXIT_SIGNAL", "ENTRY_FILLED", "EXIT_FILLED"],
            required: true,
        },
        // true for *_FILLED (a simulated position changed), false for
        // *_SIGNAL (the strategy's condition fired, nothing executed yet).
        isFill: { type: Boolean, required: true },

        title: { type: String, required: true },
        body: { type: String, required: true },

        read: { type: Boolean, default: false, index: true },
        readAt: { type: Date, default: null },
    },
    { timestamps: true },
);

// The core dedup guarantee (see file doc comment) — not just an
// optimization, the correctness mechanism itself.
notificationSchema.index({ alertConfigurationId: 1, sourceSignalId: 1 }, { unique: true });
notificationSchema.index({ userId: 1, read: 1, createdAt: -1 });

module.exports = mongoose.model("Notification", notificationSchema);
