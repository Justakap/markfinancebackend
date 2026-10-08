/**
 * Phase B/C shared contract: the professional DSL's validator (Phase B)
 * and the Indicator Engine (Phase C) must agree on exactly which
 * indicators exist and how to key their computed series. This registry is
 * that single source of truth for both.
 *
 * Deliberately short today. Per BLOCKER-001 (.claude/state/BLOCKERS.md),
 * only RSI and EMA have actual per-bar *series* implementations in
 * `indicatorService.js` right now (`calculateRSISeries`/
 * `calculateEMASeries`) — SMA/MACD/VWAP currently only have single-latest-
 * value functions, which is not enough for a bar-by-bar backtest or an
 * indicator-vs-indicator chart overlay. Do not register an indicator here
 * until its series function actually exists — this is what makes the
 * Phase B validator's "unknown indicator" rejection meaningful instead of
 * decorative (the legacy system's exact "Future Indicators" bug: an
 * indicator selectable in the UI but silently always-false at evaluation
 * time).
 */

const INDICATOR_REGISTRY = {
    RSI: {
        name: "RSI",
        params: {
            period: { type: "number", default: 14, min: 2, max: 200 },
        },
        warmup: (params = {}) => (Number(params.period) || 14) + 1,
    },
    EMA: {
        name: "EMA",
        params: {
            period: { type: "number", default: 20, min: 1, max: 500 },
        },
        warmup: (params = {}) => Number(params.period) || 20,
    },
};

// Mirrors backtestEngine.js's INTERVAL_CONFIG keys. Not imported from there
// to avoid a circular require (backtestEngine.js -> strategyExpression.js);
// Phase C/D should factor both into one shared `utils/timeframes.js` when
// the Indicator Engine actually needs the rest of INTERVAL_CONFIG (maxDays,
// barsPerDay) rather than just the valid-key set this validator needs.
const VALID_TIMEFRAMES = ["1m", "5m", "15m", "1h", "1d"];

const PRICE_FIELDS = ["open", "high", "low", "close", "volume"];

function isRegisteredIndicator(name) {
    return Object.prototype.hasOwnProperty.call(INDICATOR_REGISTRY, name);
}

function getIndicatorDefinition(name) {
    return INDICATOR_REGISTRY[name] || null;
}

/** Deterministic cache/lookup key for a (name, params) pair, e.g.
 *  "RSI(period=14)" — both the validator's warmup lookup and Phase C's
 *  context-building must use this exact function so they agree. */
function indicatorKey(name, params = {}) {
    const sortedParams = Object.keys(params)
        .sort()
        .map((key) => `${key}=${params[key]}`)
        .join(",");
    return `${name}(${sortedParams})`;
}

function getIndicatorWarmupBars(name, params = {}) {
    const def = getIndicatorDefinition(name);
    if (!def) return 1;
    return def.warmup(params);
}

module.exports = {
    INDICATOR_REGISTRY,
    VALID_TIMEFRAMES,
    PRICE_FIELDS,
    isRegisteredIndicator,
    getIndicatorDefinition,
    indicatorKey,
    getIndicatorWarmupBars,
};
