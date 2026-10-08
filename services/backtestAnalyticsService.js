/**
 * Phase F — professional analytics. Computes a BacktestResult.summary
 * object from Phase D's raw engine output (trades + equitySeries), split
 * explicitly into Return / Risk / Trade / Exposure / Benchmark categories
 * per the architecture audit's requirement not to blur these together.
 *
 * Documented methodology (the architecture's explicit requirement for
 * Sharpe/Sortino in particular — "document the calculation methodology"):
 *
 *  - Risk-free rate is assumed to be 0%. Getting a real historical
 *    risk-free rate series is out of scope for this phase; Sharpe/Sortino
 *    here are therefore excess-return-over-zero ratios, not excess-over-
 *    T-bill. This is a documented simplification, not a precision claim.
 *  - Annualization multiplies the per-bar Sharpe/Sortino/volatility by
 *    sqrt(BARS_PER_YEAR[timeframe]) — BARS_PER_YEAR assumes ~252 trading
 *    days/year, multiplied by bars/day for intraday timeframes (mirrors
 *    the existing legacy backtestEngine.js's INTERVAL_CONFIG.barsPerDay
 *    values, duplicated here rather than imported to avoid a dependency
 *    from the new analytics layer onto the legacy engine file).
 */

const BARS_PER_YEAR = {
    "1m": 375 * 252,
    "5m": 75 * 252,
    "15m": 25 * 252,
    "1h": 7 * 252,
    "1d": 252,
};

const SHARPE_RISK_FREE_RATE = 0;

function mean(values) {
    if (!values.length) return 0;
    return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function stdDev(values, meanValue) {
    if (values.length < 2) return 0;
    const variance = values.reduce((sum, v) => sum + (v - meanValue) ** 2, 0) / (values.length - 1);
    return Math.sqrt(variance);
}

/** Per-bar simple returns from the equity series — the input to both
 *  volatility and Sharpe/Sortino. */
function perBarReturns(equity) {
    const returns = [];
    for (let i = 1; i < equity.length; i += 1) {
        if (equity[i - 1] > 0) {
            returns.push((equity[i] - equity[i - 1]) / equity[i - 1]);
        }
    }
    return returns;
}

function computeReturnMetrics({ equitySeries, initialCapital }) {
    const equity = equitySeries.equity;
    const finalEquity = equity.length ? equity[equity.length - 1] : initialCapital;
    const totalReturnPct = initialCapital > 0 ? ((finalEquity - initialCapital) / initialCapital) * 100 : 0;

    let cagrPct = null;
    const timestamps = equitySeries.timestamps;
    if (timestamps.length >= 2 && finalEquity > 0 && initialCapital > 0) {
        const years = (new Date(timestamps[timestamps.length - 1]) - new Date(timestamps[0])) / (365.25 * 24 * 60 * 60 * 1000);
        if (years > 0) {
            cagrPct = (Math.pow(finalEquity / initialCapital, 1 / years) - 1) * 100;
        }
    }

    return {
        finalEquity: Number(finalEquity.toFixed(2)),
        totalReturnPct: Number(totalReturnPct.toFixed(2)),
        cagrPct: cagrPct === null ? null : Number(cagrPct.toFixed(2)),
    };
}

function computeRiskMetrics({ equitySeries, timeframe }) {
    const drawdowns = equitySeries.drawdownPct;
    const maxDrawdownPct = drawdowns.length ? Math.min(...drawdowns) : 0;

    // Longest consecutive run of bars spent underwater (drawdownPct < 0).
    // Measured in bars, not calendar time — bar spacing varies by
    // timeframe, so this is deliberately not labeled "days".
    let maxDrawdownDurationBars = 0;
    let currentRun = 0;
    drawdowns.forEach((value) => {
        if (value < 0) {
            currentRun += 1;
            maxDrawdownDurationBars = Math.max(maxDrawdownDurationBars, currentRun);
        } else {
            currentRun = 0;
        }
    });

    const returns = perBarReturns(equitySeries.equity);
    const barsPerYear = BARS_PER_YEAR[timeframe] || BARS_PER_YEAR["1d"];
    const avgReturn = mean(returns);
    const volatility = stdDev(returns, avgReturn);
    const annualizedVolatilityPct = volatility * Math.sqrt(barsPerYear) * 100;

    const excessReturn = avgReturn - SHARPE_RISK_FREE_RATE;
    const sharpeRatio = volatility > 0 ? (excessReturn / volatility) * Math.sqrt(barsPerYear) : null;

    const downsideReturns = returns.filter((r) => r < 0);
    const downsideDeviation = downsideReturns.length
        ? Math.sqrt(downsideReturns.reduce((sum, r) => sum + r * r, 0) / downsideReturns.length)
        : 0;
    const sortinoRatio = downsideDeviation > 0 ? (excessReturn / downsideDeviation) * Math.sqrt(barsPerYear) : null;

    return {
        maxDrawdownPct: Number(maxDrawdownPct.toFixed(2)),
        maxDrawdownDurationBars,
        annualizedVolatilityPct: Number(annualizedVolatilityPct.toFixed(2)),
        sharpeRatio: sharpeRatio === null ? null : Number(sharpeRatio.toFixed(2)),
        sortinoRatio: sortinoRatio === null ? null : Number(sortinoRatio.toFixed(2)),
        riskFreeRateAssumed: SHARPE_RISK_FREE_RATE,
    };
}

function computeTradeMetrics({ trades }) {
    const totalTrades = trades.length;
    const winningTrades = trades.filter((t) => t.netPnl > 0);
    const losingTrades = trades.filter((t) => t.netPnl <= 0);

    const grossWin = winningTrades.reduce((sum, t) => sum + t.netPnl, 0);
    const grossLoss = Math.abs(losingTrades.reduce((sum, t) => sum + t.netPnl, 0));

    const winRatePct = totalTrades > 0 ? (winningTrades.length / totalTrades) * 100 : 0;
    const profitFactor = grossLoss > 0 ? grossWin / grossLoss : null;
    const expectancy = totalTrades > 0 ? trades.reduce((sum, t) => sum + t.netPnl, 0) / totalTrades : 0;
    const averageWin = winningTrades.length ? grossWin / winningTrades.length : 0;
    const averageLoss = losingTrades.length ? -grossLoss / losingTrades.length : 0;
    const largestWin = winningTrades.length ? Math.max(...winningTrades.map((t) => t.netPnl)) : 0;
    const largestLoss = losingTrades.length ? Math.min(...losingTrades.map((t) => t.netPnl)) : 0;
    const averageHoldingPeriodBars = totalTrades > 0
        ? trades.reduce((sum, t) => sum + (t.holdingPeriodBars || 0), 0) / totalTrades
        : 0;

    return {
        totalTrades,
        winningTrades: winningTrades.length,
        losingTrades: losingTrades.length,
        winRatePct: Number(winRatePct.toFixed(2)),
        profitFactor: profitFactor === null ? null : Number(profitFactor.toFixed(2)),
        expectancy: Number(expectancy.toFixed(2)),
        averageWin: Number(averageWin.toFixed(2)),
        averageLoss: Number(averageLoss.toFixed(2)),
        largestWin: Number(largestWin.toFixed(2)),
        largestLoss: Number(largestLoss.toFixed(2)),
        averageHoldingPeriodBars: Number(averageHoldingPeriodBars.toFixed(2)),
    };
}

/** % of bars where a position was open, derived from trade date ranges
 *  against the equity series' own timestamps (Phase D's engine doesn't
 *  track an explicit per-bar in-position flag, so this is reconstructed
 *  here rather than requiring a change to the already-tested engine). */
function computeExposureMetrics({ trades, equitySeries }) {
    const timestamps = equitySeries.timestamps;
    if (!timestamps.length) return { exposurePct: 0 };

    const ranges = trades.map((t) => [new Date(t.entryDate).getTime(), new Date(t.exitDate).getTime()]);
    let barsInPosition = 0;

    timestamps.forEach((ts) => {
        const time = new Date(ts).getTime();
        const inAnyTrade = ranges.some(([start, end]) => time >= start && time <= end);
        if (inAnyTrade) barsInPosition += 1;
    });

    return { exposurePct: Number(((barsInPosition / timestamps.length) * 100).toFixed(2)) };
}

function computeBenchmarkMetrics({ equitySeries, initialCapital, totalReturnPct }) {
    const benchmark = equitySeries.benchmarkEquity;
    const finalBenchmark = benchmark.length ? benchmark[benchmark.length - 1] : initialCapital;
    const buyAndHoldReturnPct = initialCapital > 0 ? ((finalBenchmark - initialCapital) / initialCapital) * 100 : 0;

    return {
        buyAndHoldReturnPct: Number(buyAndHoldReturnPct.toFixed(2)),
        outperformancePct: Number((totalReturnPct - buyAndHoldReturnPct).toFixed(2)),
    };
}

/**
 * `trades`/`equitySeries` are Phase D's `runProfessionalBacktest()` output
 * shapes directly — no transformation needed between the engine and this
 * analytics layer.
 */
function computeBacktestSummary({ trades, equitySeries, initialCapital, timeframe }) {
    const returnMetrics = computeReturnMetrics({ equitySeries, initialCapital });

    return {
        ...returnMetrics,
        ...computeRiskMetrics({ equitySeries, timeframe }),
        ...computeTradeMetrics({ trades }),
        ...computeExposureMetrics({ trades, equitySeries }),
        ...computeBenchmarkMetrics({ equitySeries, initialCapital, totalReturnPct: returnMetrics.totalReturnPct }),
    };
}

module.exports = {
    BARS_PER_YEAR,
    SHARPE_RISK_FREE_RATE,
    computeBacktestSummary,
    computeReturnMetrics,
    computeRiskMetrics,
    computeTradeMetrics,
    computeExposureMetrics,
    computeBenchmarkMetrics,
};
