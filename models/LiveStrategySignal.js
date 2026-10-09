const mongoose = require("mongoose");

/**
 * Workstream J — append-only log of every signal/fill event a
 * LiveStrategyRuntime has produced. Doubles as the live system's
 * equivalent of BacktestTrade for EXIT_FILLED rows (same economics
 * fields: entryPrice/exitPrice/quantity/netPnl/returnPct/exitReason/
 * holdingPeriodBars), plus ENTRY_SIGNAL/EXIT_SIGNAL/ENTRY_FILLED rows for
 * full signal-history visibility (requirement: "recent signal history").
 *
 * Lives in its own collection (not embedded in LiveStrategyRuntime) for
 * the same reason BacktestTrade isn't embedded in BacktestResult — an
 * unbounded, indexed, independently-paginated history rather than a
 * growing array inside one document.
 */
const liveStrategySignalSchema = new mongoose.Schema(
    {
        runtimeId: { type: mongoose.Schema.Types.ObjectId, ref: "LiveStrategyRuntime", required: true, index: true },
        userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },

        type: {
            type: String,
            enum: ["ENTRY_SIGNAL", "ENTRY_FILLED", "EXIT_SIGNAL", "EXIT_FILLED"],
            required: true,
        },

        barDate: { type: Date, required: true },
        price: { type: Number, default: null },
        quantity: { type: Number, default: null },

        // Populated only on EXIT_FILLED, mirroring BacktestTrade's economics
        // fields exactly — same shape, same meaning, computed by the same
        // computeTradeEconomics() helper as backtesting.
        exitReason: { type: String, default: null },
        entryPrice: { type: Number, default: null },
        entryDate: { type: Date, default: null },
        grossPnl: { type: Number, default: null },
        fees: { type: Number, default: null },
        slippageCost: { type: Number, default: null },
        netPnl: { type: Number, default: null },
        returnPct: { type: Number, default: null },
        holdingPeriodBars: { type: Number, default: null },
    },
    { timestamps: true },
);

liveStrategySignalSchema.index({ runtimeId: 1, createdAt: -1 });

module.exports = mongoose.model("LiveStrategySignal", liveStrategySignalSchema);
