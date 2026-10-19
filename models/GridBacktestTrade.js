const mongoose = require("mongoose");

/**
 * Grid Backtest — append-only simulated fill/skip ledger for one historical
 * replay. Same shape discipline as GridSimulatorTrade.js (levelPrice vs.
 * fillPrice kept distinct), plus `assumedIntrabar` — true when this trade
 * came from the conservative Open-Low-High-Close fallback rather than a
 * genuine finer-grained observed candle (see gridBacktestEngine.js).
 */
const gridBacktestTradeSchema = new mongoose.Schema(
    {
        backtestId: { type: mongoose.Schema.Types.ObjectId, ref: "GridBacktestResult", required: true, index: true },
        userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },

        sequence: { type: Number, required: true },
        type: { type: String, enum: ["BUY", "SELL"], required: true },

        level: { type: Number, required: true },
        levelPrice: { type: Number, required: true },
        fillPrice: { type: Number, required: true },
        effectivePrice: { type: Number, required: true },

        qtyRequested: { type: Number, required: true },
        qtyFilled: { type: Number, required: true },
        qtySkipped: { type: Number, required: true },
        reason: { type: String, default: null },

        cashAfter: { type: Number, required: true },
        holdingsAfter: { type: Number, required: true },
        avgCostAfter: { type: Number, required: true },
        realizedPnLDelta: { type: Number, required: true, default: 0 },

        gapFill: { type: Boolean, default: false },
        assumedIntrabar: { type: Boolean, default: false },
        candleTimestamp: { type: Date, required: true },
        eventTimestamp: { type: Date, required: true },

        isSimulated: { type: Boolean, default: true, immutable: true },
    },
    { timestamps: true },
);

gridBacktestTradeSchema.index({ backtestId: 1, sequence: 1 });

module.exports = mongoose.model("GridBacktestTrade", gridBacktestTradeSchema);
