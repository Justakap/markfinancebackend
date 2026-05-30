const mongoose = require("mongoose");

const tradeSchema = new mongoose.Schema(
    {
        entryDate: Date,
        exitDate: Date,
        entryPrice: Number,
        exitPrice: Number,
        returnPct: Number,
        profit: Number,
        reason: String,
    },
    { _id: false }
);

const equityPointSchema = new mongoose.Schema(
    {
        date: Date,
        equity: Number,
    },
    { _id: false }
);

const backtestSchema = new mongoose.Schema(
    {
        userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: false },
        strategyId: { type: mongoose.Schema.Types.ObjectId, ref: "Strategy", required: true },
        symbol: { type: String, required: true },
        period: { type: String, required: true },
        capital: { type: Number, required: true },
        metrics: { type: Object, default: {} },
        trades: [tradeSchema],
        equityCurve: [equityPointSchema],
        createdAt: { type: Date, default: Date.now },
    },
    { timestamps: true }
);

module.exports = mongoose.model("Backtest", backtestSchema);
