const mongoose = require("mongoose");

/**
 * Grid Trading Simulator — append-only simulated fill/skip ledger. One
 * document per level-trigger outcome (filled, partially filled, or fully
 * skipped) produced by services/gridSimulatorEngine.js's processPriceUpdate.
 * Never represents a real broker order — `isSimulated` is always true.
 *
 * `levelPrice` (the triggering grid level) and `fillPrice` (the actual
 * event price the fill was simulated at) are deliberately separate fields
 * — see gridSimulatorEngine.js's file doc comment for why they can differ
 * (overnight gaps, or any multi-level single-event crossing).
 */
const gridSimulatorTradeSchema = new mongoose.Schema(
    {
        sessionId: { type: mongoose.Schema.Types.ObjectId, ref: "GridSimulatorSession", required: true, index: true },
        userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },

        sequence: { type: Number, required: true },
        type: { type: String, enum: ["BUY", "SELL"], required: true },

        level: { type: Number, required: true },
        levelPrice: { type: Number, required: true },
        fillPrice: { type: Number, required: true },

        qtyRequested: { type: Number, required: true },
        qtyFilled: { type: Number, required: true },
        qtySkipped: { type: Number, required: true },
        reason: { type: String, default: null },

        cashAfter: { type: Number, required: true },
        holdingsAfter: { type: Number, required: true },
        avgCostAfter: { type: Number, required: true },
        realizedPnLDelta: { type: Number, required: true, default: 0 },

        gapFill: { type: Boolean, default: false },
        eventTimestamp: { type: Date, required: true },

        isSimulated: { type: Boolean, default: true, immutable: true },
    },
    { timestamps: true },
);

gridSimulatorTradeSchema.index({ sessionId: 1, createdAt: -1 });
gridSimulatorTradeSchema.index({ sessionId: 1, sequence: 1 });

module.exports = mongoose.model("GridSimulatorTrade", gridSimulatorTradeSchema);
