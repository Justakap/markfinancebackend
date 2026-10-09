/**
 * Phase F.5 — orchestrates the full A→F pipeline against real
 * (or, in tests, injected-fake) persistence and candle data, and is the
 * ONLY place that does so. The route (routes/professionalBacktestRoutes.js)
 * stays thin: auth/ownership/input validation, then a single call here.
 *
 * Models are passed in (not required directly) so tests can inject
 * lightweight fakes without a live MongoDB connection — the same
 * dependency-injection convention this codebase already uses for every
 * route factory (createStrategyRoutes({Strategy, ...}), etc.) and for
 * Phase A's strategyVersionService.js.
 *
 * No second indicator-calculation path, no second execution engine, no
 * second analytics implementation: this function is pure plumbing around
 * strategyExpression.js (B), indicatorEngine.js (C),
 * backtestExecutionEngine.js (D/E), and backtestAnalyticsService.js (F).
 */

const {
    collectIndicatorRequirements,
    getProfessionalWarmupBars,
    validateStrategyDefinition,
} = require("../utils/strategyExpression");
const { buildStrategyContextSeries } = require("./indicatorEngine");
const { runProfessionalBacktest } = require("./backtestExecutionEngine");
const { computeBacktestSummary } = require("./backtestAnalyticsService");
const { fetchCandlesForDefinition } = require("./professionalCandleAdapter");
const { CORPORATE_ACTIONS_NOTE } = require("../utils/backtestEngine");

function makeError(statusCode, message) {
    const error = new Error(message);
    error.statusCode = statusCode;
    error.clientMessage = message;
    return error;
}

/**
 * `version.definition` must already have passed validateStrategyDefinition
 * at save time (strategyRoutes-equivalent for the new system) — it's
 * re-validated here defensively, cheaply, since a malformed definition
 * reaching the engine is exactly the class of bug Phase B's registry
 * check exists to prevent.
 */
async function runAndPersistBacktest({
    models: { BacktestResult, BacktestTrade },
    userId,
    version,
    instrumentKey,
    symbol,
    instrumentMeta,
    startDate,
    endDate,
    initialCapital,
    commissionPct,
    slippagePct,
}) {
    const definition = version.definition;

    try {
        validateStrategyDefinition(definition);
    } catch (error) {
        throw makeError(400, error.clientMessage || "Invalid strategy definition");
    }

    const requestedDays = Math.max(1, Math.ceil((endDate - startDate) / (24 * 60 * 60 * 1000)));

    const { candlesByTimeframe, primaryTimeframe, isDerivative, cappedTimeframes } = await fetchCandlesForDefinition({
        instrumentKey,
        definition,
        requestedDays,
        instrumentMeta,
    });

    const primaryCandles = candlesByTimeframe[primaryTimeframe] || [];
    if (!primaryCandles.length) {
        throw makeError(400, `No candle history available for ${symbol} on ${primaryTimeframe}. Try a shorter date range or a different instrument.`);
    }

    const requirements = [
        ...collectIndicatorRequirements(definition.entry, [], primaryTimeframe),
        ...(definition.exit ? collectIndicatorRequirements(definition.exit, [], primaryTimeframe) : []),
    ];
    const contexts = buildStrategyContextSeries({ primaryTimeframe, candlesByTimeframe, requirements });

    const startIndex = Math.max(
        getProfessionalWarmupBars(definition.entry, primaryTimeframe),
        definition.exit ? getProfessionalWarmupBars(definition.exit, primaryTimeframe) : 1,
    );

    if (startIndex >= primaryCandles.length - 1) {
        throw makeError(
            400,
            `Insufficient historical data: this strategy needs at least ${startIndex + 2} candles to clear indicator warmup, but only ${primaryCandles.length} are available for the requested range.`,
        );
    }

    const strategyForEngine = {
        entryExpression: definition.entry,
        exitExpression: definition.exit || null,
        risk: definition.risk || {},
        execution: definition.execution || {},
    };

    let engineResult;
    try {
        engineResult = runProfessionalBacktest({
            strategy: strategyForEngine,
            candles: primaryCandles,
            contexts,
            startIndex,
            primaryTimeframe,
            initialCapital,
            commissionPct,
            slippagePct,
        });
    } catch (error) {
        console.error("Professional backtest execution error:", error);
        throw makeError(500, "Backtest execution failed");
    }

    const summary = computeBacktestSummary({
        trades: engineResult.trades,
        equitySeries: engineResult.equitySeries,
        initialCapital,
        timeframe: primaryTimeframe,
    });

    const dataQuality = {
        corporateActionsAdjusted: false,
        corporateActionsNote: CORPORATE_ACTIONS_NOTE,
        // Phase B's indicator registry never registered a PE indicator —
        // a professional strategy structurally cannot reference PE at
        // all (the validator rejects any unregistered indicator), so
        // Phase 2.1A's historical-PE guard has nothing to guard here;
        // this isn't a ported protection, it's a stronger one by
        // construction. See ADR-008.
        historicalPeSupported: false,
        intrabarOrderingKnown: false,
        slTpAmbiguityPolicy: "When one bar touches both stop-loss and take-profit, the stop is always assumed to have triggered first.",
        isDerivativeInstrument: isDerivative,
        cappedTimeframes,
        // Verification-pass audit (2026-10-09) finding: this engine's
        // cost model is exactly two user-configurable percentages
        // (commissionPct, slippagePct) applied symmetrically to both
        // sides of every trade. It does NOT include, and never has
        // included, STT, exchange transaction charges, GST, SEBI
        // turnover fees, or stamp duty — the actual statutory charges on
        // a real Indian equity trade, which are asymmetric (e.g. STT is
        // sell-side-only intraday, buy-side-only for stamp duty) and
        // cannot be approximated by one symmetric percentage at any
        // value. `netPnl`/`totalReturnPct`/every trade-statistics field
        // in `summary` reflects ONLY commission+slippage as configured
        // below — never real-world-complete trading costs. This is a
        // stated limitation (BLOCKER-007), not silently implied to be
        // complete.
        tradingCostModelNote:
            `Costs applied: commission ${commissionPct}% + slippage ${slippagePct}% (both symmetric, both sides). ` +
            "Does NOT include STT, exchange transaction charges, GST, SEBI turnover fees, or stamp duty — " +
            "net P&L figures do not represent a real-world-complete cost accounting.",
    };

    const resultDoc = await BacktestResult.create({
        userId,
        strategyVersionId: version._id,
        instrumentKey,
        symbol,
        timeframe: primaryTimeframe,
        dateRange: { from: startDate, to: endDate },
        initialCapital,
        executionConfig: {
            fillRule: "signal-close-next-bar-open",
            slTpAmbiguityPolicy: "stop-wins-on-same-bar-touch",
            positionSizing: strategyForEngine.execution.positionSizing || { type: "percentOfEquity", value: 100 },
        },
        costConfig: { commissionPct, slippagePct },
        dataSource: "upstox",
        status: "completed",
        summary,
        equitySeries: engineResult.equitySeries,
        tradeCount: engineResult.trades.length,
        // Persisted (not just returned transiently) so GET
        // /api/v2/backtests/:id shows identical disclosures to the live
        // run response — see the schema's own comment in BacktestResult.js.
        dataQuality,
    });

    if (engineResult.trades.length) {
        await BacktestTrade.insertMany(
            engineResult.trades.map((trade) => ({ backtestResultId: resultDoc._id, ...trade })),
        );
    }

    return {
        resultDoc,
        trades: engineResult.trades,
        dataQuality,
    };
}

module.exports = { runAndPersistBacktest, makeError };
