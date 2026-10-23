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
 * `state.pendingBuyLevels`/`state.pendingSellLevels` (ADR-037) are the set
 * of currently-armed trigger prices — see gridSimulatorEngine.js's file doc
 * comment for the full per-fill paired-trigger crossing model.
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
            // Immutable anchor R — null until the session is actually
            // started (ADR-038): captured from a fresh, validated live
            // quote the moment the user clicks Start (see
            // gridSimulatorRoutes.js's captureFreshReference()), never a
            // user-typed value, and never changed again once set,
            // regardless of pause/resume/restart. A CREATED session (not
            // yet started) genuinely has no reference yet.
            referencePrice: { type: Number, default: null },
            referenceCapturedAt: { type: Date, default: null },
            gridInterval: { type: Number, required: true },
            // ADR-034: optional asymmetric sell-side spacing. null means the
            // sell side mirrors gridInterval (the original symmetric
            // behavior) — only set when the user explicitly opts into a
            // different sell variance.
            sellVariance: { type: Number, default: null },
            quantityPerLevel: { type: Number, required: true },
            // ADR-035: optional asymmetric sell-side quantity. null means
            // SELL fills mirror quantityPerLevel (the original symmetric
            // behavior) — only set when the user explicitly opts into a
            // different sell quantity.
            sellQuantityPerLevel: { type: Number, default: null },
            startingCapital: { type: Number, required: true },
            maxPositionSize: { type: Number, default: null },
            // Optional pre-existing inventory at creation — startingAvgCost
            // is required (validated at the engine layer) only when
            // startingHoldings > 0.
            startingHoldings: { type: Number, default: 0 },
            startingAvgCost: { type: Number, default: 0 },
            // ADR-040: optional price band, set at creation only (not live-
            // editable). While price is at/below lowerLimit, BUYs pause;
            // while at/above upperLimit, SELLs pause — a live gate, not a
            // one-time trip (see gridSimulatorEngine.js's processPriceUpdate).
            lowerLimit: { type: Number, default: null },
            upperLimit: { type: Number, default: null },
            // ADR-035: immutable, captured once at session creation (same
            // precedent as referencePrice) from the resolved instrument's
            // type/segment — drives the DISPLAY-ONLY statutory charges
            // estimate (services/gridChargesCalculator.js). Never affects
            // cash/holdings/realizedPnL.
            segmentClass: {
                type: String,
                enum: ["EQUITY_DELIVERY", "EQUITY_INTRADAY", "FUTURES", "OPTIONS", "COMMODITY_FUTURES", "COMMODITY_OPTIONS"],
                default: "EQUITY_DELIVERY",
            },
        },

        state: {
            cash: { type: Number, required: true },
            holdings: { type: Number, required: true, default: 0 },
            // ADR-032: the FIFO cost-basis lot queue — every filled BUY
            // pushes {qty, price} to the back; every filled SELL consumes
            // from the front (oldest first). `avgCost` below is a DERIVED
            // display value (weighted average across these lots), never
            // itself the source of realized P&L.
            lots: { type: [{ qty: Number, price: Number, _id: false }], default: () => [] },
            avgCost: { type: Number, required: true, default: 0 },
            realizedPnL: { type: Number, required: true, default: 0 },
            lastPrice: { type: Number, default: null },
            // Deprecated (ADR-037): the old single rebasing-reference
            // anchor. No longer read or written by the engine — kept only
            // so an already-persisted pre-ADR-037 session document still
            // validates/loads without a schema error until migrated (see
            // scripts/backfillGridPendingLevels.js).
            activeReference: { type: Number, default: null },
            // ADR-037: every currently-armed trigger price of that type.
            // Every filled/skipped/partial BUY at P arms a new SELL at
            // `P + sellVariance` and a new BUY at `P - buyVariance`;
            // every SELL at P arms a new BUY at `P - buyVariance` and a new
            // SELL at `P + sellVariance` — see gridSimulatorEngine.js's file
            // doc comment for the full design. Replaces `activeReference`.
            pendingBuyLevels: { type: [Number], default: () => [] },
            pendingSellLevels: { type: [Number], default: () => [] },
            lastEventTimestamp: { type: Date, default: null },
            // Deprecated (ADR-031): the old fixed-grid design's per-level
            // armed/disarmed map. No longer read or written by the engine —
            // kept only so an already-persisted pre-ADR-031 session document
            // still validates/loads without a schema error.
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
