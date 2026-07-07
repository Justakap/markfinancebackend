const axios = require("axios");
const { enqueue } = require("../utils/upstoxRequestQueue");
const {
    isInstrumentKeyBlocked,
    isInvalidInstrumentMessage,
    markInstrumentKeyInvalid,
    canFetchCandles,
} = require("../utils/instrumentKeyResolver");

const { dedupe } = require("../utils/requestDedup");

const RSI_CANDLE_CONFIGS = [
    { interval: "minutes", unit: "1" },
    { interval: "minutes", unit: "5" },
    { interval: "minutes", unit: "15" },
    { interval: "hours", unit: "1" },
    { interval: "days", unit: "1" },
];

function getAccessToken() {
    return process.env.UPSTOX_ACCESS_TOKEN || process.env.UPSTOX_TOKEN || "";
}

function extractUpstoxErrorMessage(error) {
    return (
        error.response?.data?.errors?.[0]?.message ||
        error.response?.data?.message ||
        error.message ||
        ""
    );
}

function handleCandleApiError(instrumentKey, error) {
    const message = extractUpstoxErrorMessage(error);

    if (isInvalidInstrumentMessage(message)) {
        markInstrumentKeyInvalid(instrumentKey, message);
        return true;
    }

    return false;
}

const assertCandleInstrumentKey = canFetchCandles;

function formatDate(date) {
    return date.toISOString().slice(0, 10);
}

function getDateRangeForUnit(unit) {
    const toDate = formatDate(new Date());

    if (unit === "minutes") {
        return {
            toDate,
            fromDate: formatDate(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)),
        };
    }

    if (unit === "hours") {
        return {
            toDate,
            fromDate: formatDate(new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)),
        };
    }

    return {
        toDate,
        fromDate: formatDate(new Date(Date.now() - 365 * 24 * 60 * 60 * 1000)),
    };
}

async function fetchIntradayCandles(instrumentKey, options = {}) {
    const token = getAccessToken();
    if (!token || !(await assertCandleInstrumentKey(instrumentKey))) return [];

    const rawUnit = options.interval || "minutes";
    const rawInterval = options.unit || "1";
    const unit = rawUnit === "hours" ? "minutes" : rawUnit;
    const interval =
        rawUnit === "hours" ? String(Number(rawInterval) * 60) : rawInterval;
    const encodedKey = encodeURIComponent(instrumentKey);
    const url = `https://api.upstox.com/v3/historical-candle/intraday/${encodedKey}/${unit}/${interval}`;
    const maxBars = options.maxBars || 250;

    try {
        const response = await enqueue(() =>
            axios.get(url, {
                headers: {
                    Accept: "application/json",
                    Authorization: `Bearer ${token}`,
                },
                timeout: 20000,
            }),
        );

        const candles = response.data?.data?.candles || response.data?.candles || [];

        return candles
            .map(normalizeCandle)
            .filter((candle) => Number.isFinite(candle.close))
            .reverse()
            .slice(-maxBars);
    } catch (error) {
        if (handleCandleApiError(instrumentKey, error)) {
            return [];
        }
        throw error;
    }
}

function normalizeCandle(raw) {
    if (Array.isArray(raw)) {
        const [timestamp, open, high, low, close, volume, oi] = raw;
        return {
            timestamp,
            open: Number(open),
            high: Number(high),
            low: Number(low),
            close: Number(close),
            volume: Number(volume || 0),
            oi: Number(oi || 0),
        };
    }

    return {
        timestamp: raw.timestamp || raw.ts || raw.date,
        open: Number(raw.open),
        high: Number(raw.high),
        low: Number(raw.low),
        close: Number(raw.close),
        volume: Number(raw.volume || raw.vol || 0),
        oi: Number(raw.oi || 0),
    };
}

async function fetchHistoricalCandlesByRange(
    instrumentKey,
    unit,
    interval,
    fromDate,
    toDate,
    options = {},
) {
    const maxBars = options.maxBars || 500;
    const token = getAccessToken();
    if (!token || !(await assertCandleInstrumentKey(instrumentKey))) return [];

    const encodedKey = encodeURIComponent(instrumentKey);
    const url = `https://api.upstox.com/v3/historical-candle/${encodedKey}/${unit}/${interval}/${toDate}/${fromDate}`;

    try {
        const response = await enqueue(() =>
            axios.get(url, {
                headers: {
                    Accept: "application/json",
                    Authorization: `Bearer ${token}`,
                },
                timeout: 20000,
            }),
        );

        const candles = response.data?.data?.candles || response.data?.candles || [];
        return candles
            .map(normalizeCandle)
            .filter((candle) => Number.isFinite(candle.close))
            .reverse()
            .slice(-maxBars);
    } catch (error) {
        if (handleCandleApiError(instrumentKey, error)) {
            return [];
        }
        throw error;
    }
}

function bucketHourTimestamp(value) {
    const ts = new Date(value).getTime();
    if (!Number.isFinite(ts)) return null;
    const bucket = Math.floor(ts / (60 * 60 * 1000)) * 60 * 60 * 1000;
    return new Date(bucket).toISOString();
}

function aggregateToHourlyCandles(candles = []) {
    if (!Array.isArray(candles) || !candles.length) return [];

    const grouped = new Map();

    candles.forEach((candle) => {
        const hourKey = bucketHourTimestamp(candle.timestamp);
        if (!hourKey) return;

        const close = Number(candle.close);
        if (!Number.isFinite(close)) return;

        const open = Number(candle.open);
        const high = Number(candle.high);
        const low = Number(candle.low);
        const volume = Number(candle.volume || 0);
        const oi = Number(candle.oi || 0);

        const existing = grouped.get(hourKey);
        if (!existing) {
            grouped.set(hourKey, {
                timestamp: hourKey,
                open: Number.isFinite(open) ? open : close,
                high: Number.isFinite(high) ? high : close,
                low: Number.isFinite(low) ? low : close,
                close,
                volume: Number.isFinite(volume) ? volume : 0,
                oi: Number.isFinite(oi) ? oi : 0,
            });
            return;
        }

        existing.high = Math.max(existing.high, Number.isFinite(high) ? high : close);
        existing.low = Math.min(existing.low, Number.isFinite(low) ? low : close);
        existing.close = close;
        existing.volume += Number.isFinite(volume) ? volume : 0;
        if (Number.isFinite(oi)) existing.oi = oi;
    });

    return [...grouped.values()].sort(
        (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );
}

function getDateRangeForPeriodDays(unit, periodDays = 365) {
    const toDate = formatDate(new Date());
    const days = Math.max(1, Number(periodDays) || 365);
    const fromDate = formatDate(new Date(Date.now() - days * 24 * 60 * 60 * 1000));
    return { toDate, fromDate };
}

function candleTimestampKey(candle) {
    const ms = new Date(candle?.timestamp).getTime();
    return Number.isFinite(ms) ? ms : null;
}

function mergeCandlesByTimestamp(primary = [], secondary = []) {
    const byMs = new Map();

    [...primary, ...secondary].forEach((candle) => {
        const key = candleTimestampKey(candle);
        if (key == null) return;
        byMs.set(key, candle);
    });

    return [...byMs.values()].sort(
        (a, b) => candleTimestampKey(a) - candleTimestampKey(b),
    );
}

async function fetchHistoricalCandles(instrumentKey, options = {}) {
    const token = getAccessToken();
    if (!token || !(await assertCandleInstrumentKey(instrumentKey))) return [];

    const requestedUnit = options.interval || "days";
    const requestedInterval = options.unit || "1";
    const periodDays = options.periodDays;
    const maxBars = options.maxBars || 500;

    if (isInstrumentKeyBlocked(instrumentKey)) {
        return [];
    }

    if (requestedUnit === "hours") {
        const { toDate, fromDate } = getDateRangeForUnit("hours");
        const directHourly = await fetchHistoricalCandlesByRange(
            instrumentKey,
            "minutes",
            "60",
            fromDate,
            toDate,
        );
        if (directHourly.length) {
            return directHourly.slice(-maxBars);
        }

        const minuteCandles = await fetchIntradayCandles(instrumentKey, {
            interval: "minutes",
            unit: "1",
        });
        const hourly = aggregateToHourlyCandles(minuteCandles);
        if (hourly.length) return hourly.slice(-maxBars);
    }

    const unit = requestedUnit;
    const interval = requestedInterval;

    if (unit === "minutes") {
        const range =
            periodDays != null
                ? getDateRangeForPeriodDays(unit, periodDays)
                : getDateRangeForUnit(unit);
        const { toDate, fromDate } = range;

        let historical = [];
        try {
            historical = await fetchHistoricalCandlesByRange(
                instrumentKey,
                unit,
                interval,
                fromDate,
                toDate,
                { maxBars },
            );
        } catch {
            historical = [];
        }

        const intraday = await fetchIntradayCandles(instrumentKey, {
            interval: unit,
            unit: interval,
            maxBars,
        }).catch(() => []);

        if (historical.length && intraday.length) {
            return mergeCandlesByTimestamp(historical, intraday).slice(-maxBars);
        }
        if (intraday.length) return intraday.slice(-maxBars);
        if (historical.length) return historical.slice(-maxBars);
    }

    if (unit === "hours") {
        const intraday = await fetchIntradayCandles(instrumentKey, {
            interval: unit,
            unit: interval,
            maxBars,
        });
        if (intraday.length) return intraday;
    }

    if (isInstrumentKeyBlocked(instrumentKey)) {
        return [];
    }

    const range =
        periodDays != null
            ? getDateRangeForPeriodDays(unit, periodDays)
            : getDateRangeForUnit(unit);
    const { toDate, fromDate } = range;

    const candles = await fetchHistoricalCandlesByRange(
        instrumentKey,
        unit,
        interval,
        fromDate,
        toDate,
        { maxBars },
    );
    return candles.slice(-maxBars);
}

async function getCandles(instrumentKey, options = {}) {
    if (!instrumentKey || isInstrumentKeyBlocked(instrumentKey)) return [];

    if (!(await assertCandleInstrumentKey(instrumentKey))) {
        return [];
    }

    const requestedUnit = options.interval || "days";
    const requestedInterval = options.unit || "1";
    const periodDays = options.periodDays;
    const maxBars = options.maxBars;
    const normalizedUnit = requestedUnit;
    const normalizedInterval = requestedInterval;

    const key = `${instrumentKey}:${normalizedUnit}:${normalizedInterval}:${periodDays || ""}:${maxBars || ""}`;

    return dedupe(`candles:${key}`, async () => {
        try {
            return await fetchHistoricalCandles(instrumentKey, {
                interval: requestedUnit,
                unit: requestedInterval,
                periodDays,
                maxBars,
            });
        } catch {
            return [];
        }
    });
}

async function warmCandles(instrumentKeys = []) {
    const uniqueKeys = [
        ...new Set(instrumentKeys.filter(Boolean)),
    ];
    const validKeys = [];

    for (const key of uniqueKeys) {
        if (await canFetchCandles(key)) {
            validKeys.push(key);
        }
    }

    const jobs = [];

    validKeys.forEach((key) => {
        RSI_CANDLE_CONFIGS.forEach((cfg) => {
            jobs.push(getCandles(key, cfg).catch(() => []));
        });
    });

    await Promise.allSettled(jobs);
}

function toBacktestQuote(candle) {
    return {
        date: new Date(candle.timestamp),
        open: candle.open ?? candle.close,
        high: candle.high ?? candle.close,
        low: candle.low ?? candle.close,
        close: candle.close,
        volume: candle.volume ?? 0,
    };
}

module.exports = {
    getCandles,
    warmCandles,
    RSI_CANDLE_CONFIGS,
    toBacktestQuote,
    normalizeCandle,
};
