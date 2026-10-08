/**
 * Phase C — Series-first Indicator Engine + StrategyContext builder.
 *
 * Takes already-fetched, already-normalized OHLCV candles (fetching/
 * caching them is the historical-data-provider layer's job — candleService.js/
 * backtestEngine.js's fetch helpers, reused as-is, not duplicated here) and
 * produces the per-bar StrategyContext sequence that
 * strategyExpression.js's evaluateProfessionalExpression() consumes.
 *
 * Causality is structural, not incidental: every series function in
 * indicatorService.js computes index i from candles[0..i] only, and the
 * cross-timeframe alignment below (alignRowsToPrimary) only ever looks at
 * auxiliary bars whose timestamp is <= the primary bar's timestamp. There
 * is no code path in this file that can read a future bar.
 */

const {
    calculateRSISeries,
    calculateEMASeries,
    calculateSMASeries,
    calculateMACDSeries,
    calculateVWAPSeries,
} = require("./indicatorService");
const { indicatorKey, getIndicatorDefinition } = require("../utils/indicatorRegistry");

/** Each builder returns { [indicatorName]: series[] } — usually one entry,
 *  but MACD computes macd+signal+histogram together in one pass and
 *  exposes two of them as separately-selectable registry entries. */
const SERIES_BUILDERS = {
    RSI: (candles, params) => ({ RSI: calculateRSISeries(candles, Number(params.period) || 14) }),
    EMA: (candles, params) => ({ EMA: calculateEMASeries(candles, Number(params.period) || 20) }),
    SMA: (candles, params) => ({ SMA: calculateSMASeries(candles, Number(params.period) || 20) }),
    MACD: (candles) => {
        const { macd, signal } = calculateMACDSeries(candles);
        return { MACD: macd, MACD_SIGNAL: signal };
    },
    MACD_SIGNAL: (candles) => {
        const { macd, signal } = calculateMACDSeries(candles);
        return { MACD: macd, MACD_SIGNAL: signal };
    },
    VWAP: (candles) => ({ VWAP: calculateVWAPSeries(candles) }),
};

/**
 * Computes every indicator series a set of (deduplicated) requirements
 * needs, against one candle array. Returns a map of
 * `indicatorKey(name,params) -> series[]`, same length/index alignment as
 * `candles`.
 */
function computeSeriesForCandles(candles, requirements) {
    const seriesByKey = {};
    const computedBuilders = new Set();

    requirements.forEach((req) => {
        const key = indicatorKey(req.name, req.params || {});
        if (seriesByKey[key]) return;

        if (!getIndicatorDefinition(req.name)) {
            // Should never happen if validateStrategyDefinition ran first —
            // fail loudly rather than silently producing an always-null
            // series (the exact failure mode this phase exists to prevent).
            throw new Error(`No series builder registered for indicator "${req.name}"`);
        }

        // MACD/MACD_SIGNAL share one underlying computation per candle
        // array+params — only run it once even if both are requested.
        const builderCacheKey = `${req.name === "MACD_SIGNAL" ? "MACD" : req.name}(${JSON.stringify(req.params || {})})`;
        if (!computedBuilders.has(builderCacheKey)) {
            computedBuilders.add(builderCacheKey);
            const produced = SERIES_BUILDERS[req.name](candles, req.params || {});
            Object.entries(produced).forEach(([name, series]) => {
                seriesByKey[indicatorKey(name, req.params || {})] = series;
            });
        }
    });

    return seriesByKey;
}

function candleTimestamp(candle) {
    const ts = candle.date ?? candle.timestamp;
    return ts ? new Date(ts).getTime() : null;
}

function buildRows(candles, seriesByKey) {
    return candles.map((candle, index) => {
        const indicators = {};
        Object.keys(seriesByKey).forEach((key) => {
            indicators[key] = seriesByKey[key][index] ?? null;
        });

        return {
            open: candle.open ?? candle.close,
            high: candle.high ?? candle.close,
            low: candle.low ?? candle.close,
            close: candle.close,
            volume: candle.volume,
            indicators,
        };
    });
}

/**
 * Aligns auxiliary-timeframe rows onto the primary timeframe's bar index.
 * For each primary bar, uses the LAST auxiliary row whose timestamp is
 * <= the primary bar's timestamp (two-pointer walk, both arrays assumed
 * sorted ascending by time — true of every candle source in this
 * codebase). Never looks ahead: an auxiliary bar that hasn't closed yet
 * relative to the primary bar is never selected.
 */
function alignRowsToPrimary(primaryCandles, auxiliaryCandles, auxiliaryRows) {
    const aligned = new Array(primaryCandles.length).fill(null);
    let auxIndex = -1;

    primaryCandles.forEach((primaryCandle, i) => {
        const primaryTs = candleTimestamp(primaryCandle);

        while (
            auxIndex + 1 < auxiliaryCandles.length &&
            candleTimestamp(auxiliaryCandles[auxIndex + 1]) !== null &&
            candleTimestamp(auxiliaryCandles[auxIndex + 1]) <= primaryTs
        ) {
            auxIndex += 1;
        }

        aligned[i] = auxIndex >= 0 ? auxiliaryRows[auxIndex] : null;
    });

    return aligned;
}

/**
 * `candlesByTimeframe`: `{ [timeframe]: candles[] }`, already fetched —
 * must include an entry for every timeframe any requirement references
 * (defaulted to `primaryTimeframe` by collectIndicatorRequirements's
 * caller before this runs).
 *
 * Returns an array the same length as the primary timeframe's candles,
 * where `contexts[i]` is the `{ [timeframe]: row }` StrategyContext
 * object for that bar — ready to pass straight into
 * evaluateProfessionalExpression(contexts[i], contexts[i-1], tree, primaryTimeframe).
 */
function buildStrategyContextSeries({ primaryTimeframe, candlesByTimeframe, requirements }) {
    const primaryCandles = candlesByTimeframe[primaryTimeframe] || [];
    const requirementsByTimeframe = {};

    requirements.forEach((req) => {
        const timeframe = req.timeframe || primaryTimeframe;
        if (!requirementsByTimeframe[timeframe]) requirementsByTimeframe[timeframe] = [];
        requirementsByTimeframe[timeframe].push(req);
    });

    const rowsByTimeframe = {};
    Object.entries(requirementsByTimeframe).forEach(([timeframe, reqs]) => {
        const candles = candlesByTimeframe[timeframe] || [];
        const seriesByKey = computeSeriesForCandles(candles, reqs);
        rowsByTimeframe[timeframe] = buildRows(candles, seriesByKey);
    });

    // A timeframe with no indicator requirements (e.g. only price/constant
    // operands reference it) still needs raw OHLCV rows.
    const allTimeframes = new Set([primaryTimeframe, ...Object.keys(requirementsByTimeframe)]);
    allTimeframes.forEach((timeframe) => {
        if (!rowsByTimeframe[timeframe]) {
            rowsByTimeframe[timeframe] = buildRows(candlesByTimeframe[timeframe] || [], {});
        }
    });

    const contexts = primaryCandles.map((_, i) => ({ [primaryTimeframe]: rowsByTimeframe[primaryTimeframe][i] }));

    allTimeframes.forEach((timeframe) => {
        if (timeframe === primaryTimeframe) return;

        const auxCandles = candlesByTimeframe[timeframe] || [];
        const alignedRows = alignRowsToPrimary(primaryCandles, auxCandles, rowsByTimeframe[timeframe]);
        alignedRows.forEach((row, i) => {
            contexts[i][timeframe] = row;
        });
    });

    return contexts;
}

module.exports = {
    computeSeriesForCandles,
    buildRows,
    alignRowsToPrimary,
    buildStrategyContextSeries,
};
