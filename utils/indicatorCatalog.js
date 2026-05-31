/** Canonical strategy-builder indicators and field mapping */

const INDICATOR_GROUPS = [
    {
        label: "Price",
        items: [
            "Price",
            "Price Change %",
            "Volume",
            "Volume Change %",
            "PE Ratio",
        ],
    },
    {
        label: "RSI",
        items: [
            "RSI (1 Minute)",
            "RSI (5 Minute)",
            "RSI (15 Minute)",
            "RSI (1 Hour)",
            "RSI (Daily)",
        ],
    },
    {
        label: "EMA",
        items: ["EMA20", "EMA50", "EMA200"],
    },
    {
        label: "Future Indicators",
        items: [
            "MACD",
            "VWAP",
            "Bollinger Bands",
            "ATR",
            "ADX",
            "Supertrend",
        ],
        disabled: true,
    },
];

const ALL_INDICATORS = INDICATOR_GROUPS.flatMap((group) => group.items);

const FUTURE_INDICATORS = new Set(INDICATOR_GROUPS.find((g) => g.disabled)?.items || []);

/** Maps display label -> property on market/backtest row */
const FIELD_BY_LABEL = {
    Price: "price",
    "Price Change %": "change",
    Volume: "volume",
    "Volume Change %": "volumeChange",
    "PE Ratio": "pe",

    "RSI (1 Minute)": "rsi1m",
    "RSI (5 Minute)": "rsi5m",
    "RSI (15 Minute)": "rsi15m",
    "RSI (1 Hour)": "hourlyRsi",
    "RSI (Daily)": "rsi",

    EMA20: "ema20",
    EMA50: "ema50",
    EMA200: "ema200",

    SMA20: "sma20",
    SMA50: "sma50",

    "52 Week High %": "high52Pct",
    "52 Week Low %": "low52Pct",
};

/** Legacy strategy documents */
const LEGACY_LABEL_ALIASES = {
    RSI14: "RSI (Daily)",
    "RSI Change": null,
    "Hourly RSI": "RSI (1 Hour)",
    "Hourly RSI Change": null,
    "15 Min RSI": "RSI (15 Minute)",
    "15 Min RSI Change": null,
    "5 Min RSI": "RSI (5 Minute)",
    "5 Min RSI Change": null,
    "1 Min RSI": "RSI (1 Minute)",
    "1 Min RSI Change": null,
};

const PREV_FIELD_BY_LABEL = {
    Price: "prevPrice",
    "RSI (Daily)": "prevRsi",
    "RSI (1 Hour)": "prevHourlyRsi",
    "RSI (15 Minute)": "prevRsi15m",
    "RSI (5 Minute)": "prevRsi5m",
    "RSI (1 Minute)": "prevRsi1m",
    EMA20: "prevEma20",
    EMA50: "prevEma50",
    EMA200: "prevEma200",
    SMA20: "prevSma20",
    SMA50: "prevSma50",
};

function normalizeIndicatorLabel(label) {
    if (!label) return null;

    if (FIELD_BY_LABEL[label]) return label;

    const alias = LEGACY_LABEL_ALIASES[label];

    if (alias === null) return null;

    return alias || label;
}

function getFieldForIndicator(label) {
    const normalized = normalizeIndicatorLabel(label);

    if (!normalized || FUTURE_INDICATORS.has(normalized)) return null;

    return FIELD_BY_LABEL[normalized] || null;
}

function getPrevFieldForIndicator(label) {
    const normalized = normalizeIndicatorLabel(label);

    if (!normalized) return null;

    return PREV_FIELD_BY_LABEL[normalized] || null;
}

function getIndicatorWarmup(label) {
    const normalized = normalizeIndicatorLabel(label);

    if (!normalized) return 1;

    if (normalized.startsWith("RSI")) return 14;
    if (normalized === "EMA20" || normalized === "SMA20") return 19;
    if (normalized === "EMA50" || normalized === "SMA50") return 49;
    if (normalized === "EMA200") return 199;

    return 1;
}

module.exports = {
    INDICATOR_GROUPS,
    ALL_INDICATORS,
    FUTURE_INDICATORS,
    FIELD_BY_LABEL,
    normalizeIndicatorLabel,
    getFieldForIndicator,
    getPrevFieldForIndicator,
    getIndicatorWarmup,
};
