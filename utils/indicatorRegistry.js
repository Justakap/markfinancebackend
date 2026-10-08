/**
 * Phase B/C shared contract: the professional DSL's validator (Phase B)
 * and the Indicator Engine (Phase C) must agree on exactly which
 * indicators exist and how to key their computed series. This registry is
 * that single source of truth for both.
 *
 * Only register an indicator once its series function actually exists in
 * `indicatorService.js` — this is what makes the Phase B validator's
 * "unknown indicator" rejection meaningful instead of decorative (the
 * legacy system's exact "Future Indicators" bug: an indicator selectable
 * in the UI but silently always-false at evaluation time, with no warning
 * anywhere). RSI/EMA/SMA/MACD/MACD_SIGNAL/VWAP all have real series
 * functions as of Phase C (see BLOCKERS.md — BLOCKER-001 resolved for
 * these six; Bollinger/ATR/ADX/Supertrend remain deliberately
 * unregistered, not yet implemented).
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
    SMA: {
        name: "SMA",
        params: {
            period: { type: "number", default: 20, min: 1, max: 500 },
        },
        warmup: (params = {}) => Number(params.period) || 20,
    },
    // Fixed 12/26/9 — matches indicatorService.js's calculateMACDSeries,
    // which isn't parameterized yet. MACD and its signal line are
    // registered as two separately-selectable indicator names (matching
    // how the architecture's own DSL example writes "MACD > MACD_SIGNAL"
    // as two operands), computed together under the hood.
    MACD: {
        name: "MACD",
        params: {},
        warmup: () => 35, // slowPeriod(26) + signalPeriod(9)
    },
    MACD_SIGNAL: {
        name: "MACD_SIGNAL",
        params: {},
        warmup: () => 35,
    },
    // Session-anchored — resets every trading day, so its "warmup" is
    // just needing the current session's bars so far, not a fixed lookback.
    VWAP: {
        name: "VWAP",
        params: {},
        warmup: () => 1,
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
