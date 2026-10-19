const mongoose = require("mongoose");

/**
 * Grid Trading Simulator — PAPER TRADING ONLY. One document per simulator
 * session: a fixed grid anchored to `config.referencePrice`, evaluated
 * event-driven against genuine Upstox WebSocket ticks (falling back to
 * REST-polled prices, honestly labeled, only while the socket is down)
 * for `instrumentKey`.
 *
 * `state` mirrors services/gridSimulatorEngine.js's state shape exactly —
 * it is the ONLY place that state lives; a restart reads it back and
 * resumes from exactly where it left off (see services/gridSimulatorRealtime.js).
 * `state.lastEventTimestamp` is the monotonic dedup/out-of-order watermark;
 * `state.levelArmed` is a sparse map (grid-level-index -> armed boolean,
 * default true when absent — see gridSimulatorEngine.js's file doc comment
 * for the full crossing/re-arming model).
 *
 * `processingLockedUntil` is a short-TTL claim, same idiom as
 * LiveStrategyRuntime.processingLockedUntil — prevents two concurrent
 * processors (a genuine upstream WebSocket tick and a frontend-pushed
 * tick, or two backend processes) from processing overlapping price
 * updates for the same session at once.
 */
const gridSimulatorSessionSchema = new mongoose.Schema(
    {
        userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },

        instrumentKey: { type: String, required: true },
        symbol: { type: String, required: true },

        status: { type: String, enum: ["CREATED", "ACTIVE", "PAUSED", "STOPPED"], default: "CREATED", index: true },

        config: {
            // Immutable anchor R — captured from a fresh, validated live
            // quote at session-creation time (see gridSimulatorRoutes.js's
            // captureFreshReference()), never a user-typed value, and never
            // changed again regardless of pause/resume/restart.
            referencePrice: { type: Number, required: true },
            referenceCapturedAt: { type: Date, required: true },
            gridInterval: { type: Number, required: true },
            quantityPerLevel: { type: Number, required: true },
            startingCapital: { type: Number, required: true },
            maxPositionSize: { type: Number, default: null },
            commissionPct: { type: Number, default: 0 },
            slippagePct: { type: Number, default: 0 },
            // Optional pre-existing inventory at creation — startingAvgCost
            // is required (validated at the engine layer) only when
            // startingHoldings > 0.
            startingHoldings: { type: Number, default: 0 },
            startingAvgCost: { type: Number, default: 0 },
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
            // Total trade-ledger rows ever written for this session —
            // deliberately separate from `sequence` (the engine's own
            // per-EVENT watermark). A single event can produce many trades
            // (an overnight gap crossing ten levels), so numbering ledger
            // rows from the per-event counter would collide across events;
            // see services/gridSimulatorService.js's tradeToDoc/processTick.
            tradeSequence: { type: Number, default: 0 },
        },

        // Feed health — never implied "live" without a fresh, genuine read.
        lastFeedCheckAt: { type: Date, default: null },
        // LIVE = a genuine Upstox WebSocket tick arrived recently.
        // LIVE_REST_FALLBACK = only REST-polled prices have arrived
        // recently (WS is down) — never reported as plain "LIVE", so the
        // frontend can honestly distinguish the two (never claim a
        // WebSocket/live badge merely because *a* price arrived).
        lastFeedStatus: { type: String, enum: ["UNKNOWN", "LIVE", "LIVE_REST_FALLBACK", "STALE", "NO_DATA"], default: "UNKNOWN" },
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
