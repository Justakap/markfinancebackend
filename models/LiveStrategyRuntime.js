const mongoose = require("mongoose");

/**
 * Workstream J — one document per "this strategy is actively evaluated
 * live against this instrument/timeframe." Unique per
 * {userId, strategyId, instrumentKey, timeframe} (see the index below) —
 * activating twice for the same combination is rejected (409) by the
 * route rather than silently creating a duplicate runtime, since two
 * runtimes both claiming/processing the same bars would corrupt
 * engineState (double-counted fills).
 *
 * `strategyVersionId` is frozen at activation time (ADR-001 extended to
 * live evaluation) — if the user edits the strategy after activating, the
 * live runtime keeps evaluating the exact version it was activated with
 * until deactivated and reactivated, never silently picking up an edit
 * mid-flight.
 *
 * `engineState` mirrors services/liveSignalEngine.js's state shape
 * exactly (equity/peakEquity/position fields/pending-signal flags) — it
 * is the ONLY place that state lives; a process restart reads it back
 * and resumes from exactly where it left off (see
 * services/liveStrategyOrchestrator.js). `lastProcessedCandleTimestamp`
 * is the monotonic dedup/out-of-order guard: a candle at or before this
 * timestamp is never reprocessed.
 *
 * `processingLockedUntil` is a short-TTL claim used only to prevent two
 * concurrent orchestrator passes (same process racing itself across
 * instruments, or two processes/workers) from processing the same new
 * bar twice — never relied on alone without the atomic
 * conditional-update pattern in the orchestrator (see its file comment).
 */
const liveStrategyRuntimeSchema = new mongoose.Schema(
    {
        userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
        strategyId: { type: mongoose.Schema.Types.ObjectId, ref: "StrategyDefinition", required: true },
        strategyVersionId: { type: mongoose.Schema.Types.ObjectId, ref: "StrategyVersion", required: true },

        instrumentKey: { type: String, required: true },
        symbol: { type: String, required: true },
        timeframe: { type: String, required: true, enum: ["1m", "5m", "15m", "1h", "1d"] },

        status: { type: String, enum: ["ACTIVE", "INACTIVE"], default: "ACTIVE", index: true },

        config: {
            initialCapital: { type: Number, required: true },
            commissionPct: { type: Number, required: true },
            slippagePct: { type: Number, required: true },
        },

        engineState: {
            equity: { type: Number, required: true },
            peakEquity: { type: Number, required: true },
            barsProcessed: { type: Number, default: 0 },
            inPosition: { type: Boolean, default: false },
            entryPrice: { type: Number, default: 0 },
            entryRawPrice: { type: Number, default: 0 },
            entryDate: { type: Date, default: null },
            quantity: { type: Number, default: 0 },
            entrySignalBarIndex: { type: Number, default: null },
            pendingEntry: { type: Boolean, default: false },
            pendingExit: { type: Boolean, default: false },
            pendingExitReason: { type: String, default: null },
        },

        lastProcessedCandleTimestamp: { type: Date, default: null },
        lastEvaluationAt: { type: Date, default: null },
        lastEvaluationStatus: { type: String, default: "No completed candle processed yet" },

        processingLockedUntil: { type: Date, default: null },

        deactivatedAt: { type: Date, default: null },
    },
    { timestamps: true },
);

// Prevents duplicate concurrent activation of the same strategy against
// the same instrument/timeframe for the same user — the one case where
// two live runtimes processing the same bars would corrupt each other's
// engineState. Partial index: an INACTIVE (deactivated) runtime is kept
// for history but no longer blocks a future reactivation.
liveStrategyRuntimeSchema.index(
    { userId: 1, strategyId: 1, instrumentKey: 1, timeframe: 1 },
    { unique: true, partialFilterExpression: { status: "ACTIVE" } },
);
liveStrategyRuntimeSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model("LiveStrategyRuntime", liveStrategyRuntimeSchema);
