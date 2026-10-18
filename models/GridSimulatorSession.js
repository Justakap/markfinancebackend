const mongoose = require("mongoose");

/**
 * Grid Trading Simulator — PAPER TRADING ONLY. One document per simulator
 * session: a fixed grid anchored to `config.referencePrice`, evaluated
 * against live/polled price updates for `instrumentKey`.
 *
 * `state` mirrors services/gridSimulatorEngine.js's state shape exactly —
 * it is the ONLY place that state lives; a restart reads it back and
 * resumes from exactly where it left off (see services/gridSimulatorFeed.js).
 * `state.lastEventTimestamp` is the monotonic dedup/out-of-order watermark;
 * `state.levelArmed` is a sparse map (grid-level-index -> armed boolean,
 * default true when absent — see gridSimulatorEngine.js's file doc comment
 * for the full crossing/re-arming model).
 *
 * `processingLockedUntil` is a short-TTL claim, same idiom as
 * LiveStrategyRuntime.processingLockedUntil — prevents two concurrent
 * processors (the backend poller and a frontend-pushed tick, or two
 * processes) from processing overlapping price updates for the same
 * session at once.
 */
const gridSimulatorSessionSchema = new mongoose.Schema(
    {
        userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },

        instrumentKey: { type: String, required: true },
        symbol: { type: String, required: true },

        status: { type: String, enum: ["CREATED", "ACTIVE", "PAUSED", "STOPPED"], default: "CREATED", index: true },

        config: {
            referencePrice: { type: Number, required: true },
            gridInterval: { type: Number, required: true },
            quantityPerLevel: { type: Number, required: true },
            startingCapital: { type: Number, required: true },
            maxPositionSize: { type: Number, default: null },
            commissionPct: { type: Number, default: 0 },
            slippagePct: { type: Number, default: 0 },
        },

        state: {
            cash: { type: Number, required: true },
            holdings: { type: Number, required: true, default: 0 },
            avgCost: { type: Number, required: true, default: 0 },
            realizedPnL: { type: Number, required: true, default: 0 },
            lastPrice: { type: Number, default: null },
            lastEventTimestamp: { type: Date, default: null },
            levelArmed: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
            sequence: { type: Number, default: 0 },
        },

        // Feed health — never implied "live" without a fresh, genuine read.
        lastFeedCheckAt: { type: Date, default: null },
        lastFeedStatus: { type: String, enum: ["UNKNOWN", "LIVE", "STALE", "NO_DATA"], default: "UNKNOWN" },
        lastFeedPrice: { type: Number, default: null },

        processingLockedUntil: { type: Date, default: null },

        startedAt: { type: Date, default: null },
        stoppedAt: { type: Date, default: null },
    },
    { timestamps: true },
);

// Only one non-terminal (CREATED/ACTIVE/PAUSED) session per user+instrument
// at a time — two overlapping sessions on the same instrument would both
// claim/process the same price updates against independent grids, which is
// confusing (not corrupting, since each session's state is independent) but
// is exactly the kind of "duplicate active session" the spec asks to
// prevent. A STOPPED session is terminal and never blocks a new one.
gridSimulatorSessionSchema.index(
    { userId: 1, instrumentKey: 1 },
    { unique: true, partialFilterExpression: { status: { $in: ["CREATED", "ACTIVE", "PAUSED"] } } },
);
gridSimulatorSessionSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model("GridSimulatorSession", gridSimulatorSessionSchema);
