const mongoose = require("mongoose");

/**
 * Phase A — one document per simulated trade, referencing its parent
 * BacktestResult by id rather than being embedded in it (see the doc
 * comment in BacktestResult.js for why: unbounded count vs. MongoDB's
 * 16MB document cap, and indexed trade-explorer queries instead of an
 * in-memory array scan).
 *
 * Field set matches what the architecture audit's BacktestResult spec
 * asked for trades[] to contain (entry/exit/side/qty/prices/gross+fees+
 * slippage+net P&L/return/holding period/exit reason) — the exit-reason
 * enum will be finalized in Phase D once the execution engine's actual
 * exit paths (signal / stop loss / take profit / trailing stop / end of
 * data) are implemented; kept as a free string with a documented expected
 * set for now rather than a premature enum lock-in.
 */
const backtestTradeSchema = new mongoose.Schema(
    {
        backtestResultId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "BacktestResult",
            required: true,
            index: true,
        },

        side: {
            type: String,
            enum: ["LONG", "SHORT"],
            default: "LONG",
        },

        quantity: { type: Number, required: true },

        entryDate: { type: Date, required: true },
        exitDate: { type: Date, required: true },
        entryPrice: { type: Number, required: true },
        exitPrice: { type: Number, required: true },

        grossPnl: { type: Number, required: true },
        fees: { type: Number, default: 0 },
        slippageCost: { type: Number, default: 0 },
        netPnl: { type: Number, required: true },
        returnPct: { type: Number, required: true },

        holdingPeriodBars: { type: Number, default: 0 },

        // Expected values (not yet enum-locked — see file doc comment):
        // "SIGNAL" | "STOP_LOSS" | "TAKE_PROFIT" | "TRAILING_STOP" | "END_OF_DATA"
        exitReason: { type: String, default: "SIGNAL" },

        // Signal bar vs. execution bar, kept distinct per the architecture's
        // signal-price-vs-execution-price requirement.
        signalEntryDate: { type: Date, default: null },
        signalExitDate: { type: Date, default: null },
    },
    { timestamps: true },
);

backtestTradeSchema.index({ backtestResultId: 1, entryDate: 1 });

module.exports = mongoose.model("BacktestTrade", backtestTradeSchema);
