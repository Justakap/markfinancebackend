const mongoose = require("mongoose");

/**
 * Phase A — new professional backtest result record. Replaces the legacy
 * `Backtest` model (models/Backtest.js, untouched) for anything run against
 * a StrategyVersion. The legacy model keeps serving old flat-condition
 * strategies; nothing here reads from or writes to its `backtests`
 * collection.
 *
 * Reproducibility (per the architecture audit): `strategyVersionId` is
 * frozen at creation — never the mutable StrategyDefinition — and
 * `executionConfig`/`costConfig` are snapshotted copies of whatever
 * assumptions produced this result, not live references to current env
 * vars/config. Re-running the same version with the same config should
 * reproduce the same trades; changing the strategy tomorrow cannot alter
 * this document.
 *
 * Trades and bar-level equity data are NOT embedded here (see ADR on
 * BacktestTrade below / `.claude/state/DECISIONS.md`) — MongoDB's 16MB
 * document cap is a real constraint for a large multi-year backtest with
 * thousands of trades, and the legacy `Backtest.js` already demonstrates
 * the failure mode (lossy, unbounded-growth embedding). Equity/drawdown is
 * still small enough per-run to keep as compact parallel arrays in this
 * same document; trades are not (unbounded count), so they live in their
 * own `BacktestTrade` collection, referenced by `_id`.
 */
const equitySeriesSchema = new mongoose.Schema(
    {
        timestamps: { type: [Date], default: [] },
        equity: { type: [Number], default: [] },
        drawdownPct: { type: [Number], default: [] },
        benchmarkEquity: { type: [Number], default: [] },
    },
    { _id: false },
);

const backtestResultSchema = new mongoose.Schema(
    {
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
            index: true,
        },

        strategyVersionId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "StrategyVersion",
            required: true,
            index: true,
        },

        instrumentKey: { type: String, required: true },
        symbol: { type: String, required: true },
        timeframe: { type: String, required: true },

        dateRange: {
            from: { type: Date, required: true },
            to: { type: Date, required: true },
        },

        initialCapital: { type: Number, required: true },

        // Snapshots, not live references — see file-level doc comment.
        executionConfig: { type: mongoose.Schema.Types.Mixed, default: {} },
        costConfig: { type: mongoose.Schema.Types.Mixed, default: {} },

        dataSource: { type: String, default: "upstox" },

        // Phase G-I finding: the frontend's results page must show the
        // same corporate-action/PE/SL-TP-ambiguity disclosures whether
        // viewing a backtest just run or reopened later from history —
        // but this was only ever returned transiently in the POST
        // /api/v2/backtest/run response, never persisted, so GET
        // /api/v2/backtests/:id silently lacked it. Minimal additive fix:
        // persist it alongside the result it describes.
        dataQuality: { type: mongoose.Schema.Types.Mixed, default: {} },

        status: {
            type: String,
            enum: ["completed", "failed"],
            default: "completed",
        },

        failureReason: { type: String, default: "" },

        // Filled in by Phase F. Reserved here so the collection/index shape
        // doesn't need to change again when Phase F lands.
        summary: { type: mongoose.Schema.Types.Mixed, default: {} },

        equitySeries: { type: equitySeriesSchema, default: () => ({}) },

        tradeCount: { type: Number, default: 0 },
    },
    { timestamps: true },
);

backtestResultSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model("BacktestResult", backtestResultSchema);
