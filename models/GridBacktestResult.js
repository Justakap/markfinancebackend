const mongoose = require("mongoose");

/**
 * Grid Backtest — historical replay of the dynamic-reference grid
 * strategy. Deliberately a distinct model/collection from both
 * `GridSimulatorSession` (live, authoritative) and the legacy
 * `BacktestResult`/professional backtest models — a backtest run shares
 * the grid engine's pure math (services/gridSimulatorEngine.js via
 * services/gridBacktestEngine.js) but never shares persisted state with a
 * live session, and is not coupled to the legacy Strategy DSL at all.
 *
 * `initialReference` is the close of the first valid historical candle in
 * the actually-replayed series (which may differ from the originally
 * requested timeframe if a finer-grained series was used — see
 * `dataQuality.usedTimeframe`) — never the live market price.
 */
const gridBacktestResultSchema = new mongoose.Schema(
    {
        userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },

        instrumentKey: { type: String, required: true },
        symbol: { type: String, required: true },

        status: { type: String, enum: ["RUNNING", "COMPLETED", "FAILED"], default: "RUNNING", index: true },
        error: { type: String, default: null },

        config: {
            timeframe: { type: String, required: true }, // "1m" | "5m" | "15m" | "1h" | "1d"
            requestedStartDate: { type: String, required: true }, // "YYYY-MM-DD"
            requestedEndDate: { type: String, required: true },
            gridInterval: { type: Number, required: true },
            quantityPerLevel: { type: Number, required: true },
            startingCapital: { type: Number, required: true },
            maxPositionSize: { type: Number, default: null },
            commissionPct: { type: Number, default: 0 },
            slippagePct: { type: Number, default: 0 },
            startingHoldings: { type: Number, default: 0 },
            startingAvgCost: { type: Number, default: 0 },
        },

        initialReference: {
            price: { type: Number, default: null },
            timestamp: { type: Date, default: null },
        },

        dataQuality: {
            usedTimeframe: { type: String, default: null }, // the timeframe actually replayed (may be finer than config.timeframe)
            actualStartDate: { type: String, default: null }, // first candle's own date actually used
            actualEndDate: { type: String, default: null },
            candleCount: { type: Number, default: 0 },
            incomplete: { type: Boolean, default: false },
            failedRanges: { type: mongoose.Schema.Types.Mixed, default: () => [] },
            retentionClamped: { type: Boolean, default: false },
            retentionFrom: { type: String, default: null },
            usedFinerGrainedCandles: { type: Boolean, default: false },
            intrabarAssumption: { type: String, enum: ["observed-finer-grained", "conservative-open-low-high-close", null], default: null },
            // Explicit, never-included-by-default disclosure — matches the
            // existing ADR-019 pattern for the live/professional engines.
            costModelNote: {
                type: String,
                default: "Commission/slippage are the only modeled costs — STT, exchange transaction charges, GST, SEBI turnover fees, and stamp duty are NOT included.",
            },
        },

        finalState: {
            cash: { type: Number, default: null },
            holdings: { type: Number, default: null },
            avgCost: { type: Number, default: null },
            realizedPnL: { type: Number, default: null },
        },

        metrics: {
            endingEquity: { type: Number, default: null },
            netPnL: { type: Number, default: null },
            returnPct: { type: Number, default: null },
            realizedPnL: { type: Number, default: null },
            unrealizedPnL: { type: Number, default: null },
            buyCount: { type: Number, default: 0 },
            sellCount: { type: Number, default: 0 },
            partialCount: { type: Number, default: 0 },
            skippedCount: { type: Number, default: 0 },
            totalCosts: { type: Number, default: 0 },
            maxDrawdownPct: { type: Number, default: 0 },
            maxCapitalDeployed: { type: Number, default: 0 },
        },

        // One point per replayed candle: {timestamp, close, equity}. Bounded
        // by the same maxBars cap used for the candle fetch itself.
        equitySeries: { type: mongoose.Schema.Types.Mixed, default: () => [] },

        completedAt: { type: Date, default: null },
    },
    { timestamps: true },
);

gridBacktestResultSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model("GridBacktestResult", gridBacktestResultSchema);
