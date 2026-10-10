/**
 * Phase F.5 — translates a StrategyVersion.definition's timeframe
 * requirements into calls against the EXISTING historical candle
 * pipeline (utils/backtestEngine.js's fetchCandleSeriesForBacktest,
 * which already does Upstox fetch + the backtestSeriesCache + unit
 * mapping + dropFormingCandle + toBacktestQuote normalization). This file
 * adds no new Upstox calls, no new caching, no new retry/backoff — it is
 * purely a timeframe-resolution adapter sitting in front of
 * infrastructure that already exists and is already tested.
 *
 * Historical data provider -> normalized OHLCV, per the architecture's
 * own layering: `candleService.js`/`backtestEngine.js`'s fetch helpers ARE
 * that layer; this module is the thin seam connecting the professional
 * DSL's declared timeframes to them.
 */

const {
    fetchCandleSeriesForBacktestWithQuality,
    INTERVAL_CONFIG,
} = require("../utils/backtestEngine");
const { collectIndicatorRequirements } = require("../utils/strategyExpression");
const { isDerivativeType } = require("../utils/instrumentKeyResolver");

/** Every distinct timeframe the strategy's entry+exit trees actually
 *  reference, always including the declared primary — reused by both the
 *  fetch step here and the context-building step in indicatorEngine.js,
 *  so there is exactly one source of truth for "what timeframes does
 *  this strategy need." */
function resolveTimeframesNeeded(definition) {
    const primaryTimeframe = definition.universe.timeframe;
    const entryReqs = collectIndicatorRequirements(definition.entry, [], primaryTimeframe);
    const exitReqs = definition.exit ? collectIndicatorRequirements(definition.exit, [], primaryTimeframe) : [];

    const timeframes = new Set([primaryTimeframe]);
    [...entryReqs, ...exitReqs].forEach((req) => timeframes.add(req.timeframe || primaryTimeframe));

    return [...timeframes];
}

/**
 * `requestedDays`: caller-computed from the request's startDate/endDate.
 * `instrumentMeta`: from marketDataService.getInstrumentMeta(instrumentKey)
 *  — used only to flag (not block) derivative instruments in the response,
 *  since F&O-specific interval caps are explicitly a deferred phase (L).
 *
 * Returns `{ candlesByTimeframe, primaryTimeframe, isDerivative,
 * cappedTimeframes, incompleteTimeframes, retentionClampedTimeframes }` —
 * `candlesByTimeframe` is exactly the shape
 * `indicatorEngine.buildStrategyContextSeries()` expects.
 *
 * `incompleteTimeframes`/`retentionClampedTimeframes` are additive
 * data-quality signals from candleService's chunked fetch: a timeframe only
 * ever lands in `incompleteTimeframes` because of a genuine caught request
 * error on one or more date-range chunks (never inferred from "zero candles
 * came back", which can legitimately mean a holiday/weekend/pre-listing
 * window) — see candleService.js's fetchHistoricalCandlesChunked. A
 * timeframe lands in `retentionClampedTimeframes` when the requested range
 * reached further back than Upstox's documented intraday retention start
 * (2022-01-01) and was clamped forward to that date.
 */
async function fetchCandlesForDefinition({ instrumentKey, definition, requestedDays, instrumentMeta }) {
    const timeframes = resolveTimeframesNeeded(definition);
    const primaryTimeframe = definition.universe.timeframe;
    const isDerivative = isDerivativeType(
        instrumentMeta?.instrumentType || instrumentMeta?.type || instrumentMeta?.assetType || "",
    );

    const candlesByTimeframe = {};
    const cappedTimeframes = [];
    const incompleteTimeframes = [];
    const retentionClampedTimeframes = [];

    for (const timeframe of timeframes) {
        const maxDays = INTERVAL_CONFIG[timeframe]?.maxDays || INTERVAL_CONFIG["1d"].maxDays;
        const effectiveDays = Math.min(requestedDays, maxDays);

        if (effectiveDays < requestedDays) {
            cappedTimeframes.push({ timeframe, requestedDays, effectiveDays, maxDays });
        }

        // eslint-disable-next-line no-await-in-loop -- sequential by design:
        // each call already goes through the shared Upstox queue/cache, no
        // benefit to firing them concurrently here and it keeps cache-key
        // collisions impossible to race. (Per-chunk fetches WITHIN a single
        // timeframe's call below are still parallelized — a separate, safe
        // case, since each chunk has its own distinct cache key; see
        // candleService.js's fetchHistoricalCandlesChunked.)
        const { series, dataQuality } = await fetchCandleSeriesForBacktestWithQuality(instrumentKey, timeframe, effectiveDays);
        candlesByTimeframe[timeframe] = series;

        if (dataQuality.incomplete) {
            incompleteTimeframes.push({ timeframe, failedRanges: dataQuality.failedRanges });
        }
        if (dataQuality.retentionClamped) {
            retentionClampedTimeframes.push({ timeframe, retentionFrom: dataQuality.retentionFrom });
        }
    }

    return {
        candlesByTimeframe,
        primaryTimeframe,
        isDerivative,
        cappedTimeframes,
        incompleteTimeframes,
        retentionClampedTimeframes,
    };
}

module.exports = {
    resolveTimeframesNeeded,
    fetchCandlesForDefinition,
};
