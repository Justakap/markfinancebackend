const axios = require("axios");

const candleCache = new Map();
const CANDLE_TTL_MS = Number(process.env.UPSTOX_CANDLE_TTL_MS || 5 * 60 * 1000);
const INTRADAY_CANDLE_TTL_MS = Number(
    process.env.UPSTOX_INTRADAY_CANDLE_TTL_MS || 60 * 1000,
);

const RSI_CANDLE_CONFIGS = [
    { interval: "minutes", unit: "5" },
    { interval: "minutes", unit: "15" },
    { interval: "hours", unit: "1" },
    { interval: "days", unit: "1" },
];

function getAccessToken() {
    return process.env.UPSTOX_ACCESS_TOKEN || process.env.UPSTOX_TOKEN || "";
}

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
    if (!token) return [];

    const rawUnit = options.interval || "minutes";
    const rawInterval = options.unit || "1";
    const unit = rawUnit === "hours" ? "minutes" : rawUnit;
    const interval = rawUnit === "hours" ? String(Number(rawInterval) * 60) : rawInterval;
    const encodedKey = encodeURIComponent(instrumentKey);
    const url = `https://api.upstox.com/v3/historical-candle/intraday/${encodedKey}/${unit}/${interval}`;

    const response = await axios.get(url, {
        headers: {
            Accept: "application/json",
            Authorization: `Bearer ${token}`,
        },
        timeout: 15000,
    });

    const candles = response.data?.data?.candles || response.data?.candles || [];

    return candles
        .map(normalizeCandle)
        .filter((candle) => Number.isFinite(candle.close))
        .reverse()
        .slice(-250);
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
) {
    const token = getAccessToken();
    if (!token) return [];

    const encodedKey = encodeURIComponent(instrumentKey);
    const url = `https://api.upstox.com/v3/historical-candle/${encodedKey}/${unit}/${interval}/${toDate}/${fromDate}`;

    const response = await axios.get(url, {
        headers: {
            Accept: "application/json",
            Authorization: `Bearer ${token}`,
        },
        timeout: 15000,
    });

    const candles = response.data?.data?.candles || response.data?.candles || [];
    return candles
        .map(normalizeCandle)
        .filter((candle) => Number.isFinite(candle.close))
        .reverse()
        .slice(-500);
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

async function fetchHistoricalCandles(instrumentKey, options = {}) {
    const token = getAccessToken();
    if (!token) return [];

    const requestedUnit = options.interval || "days";
    const requestedInterval = options.unit || "1";

    if (requestedUnit === "hours") {
        try {
            const { toDate, fromDate } = getDateRangeForUnit("hours");
            const directHourly = await fetchHistoricalCandlesByRange(
                instrumentKey,
                "minutes",
                "60",
                fromDate,
                toDate,
            );
            if (directHourly.length) {
                return directHourly.slice(-250);
            }
        } catch (error) {
            console.log(
                `Upstox direct hourly candles ${instrumentKey}:`,
                error.response?.data?.errors?.[0]?.message || error.message,
            );
        }

        try {
            const minuteCandles = await fetchIntradayCandles(instrumentKey, {
                interval: "minutes",
                unit: "1",
            });
            const hourly = aggregateToHourlyCandles(minuteCandles);
            if (hourly.length) return hourly.slice(-250);
        } catch (error) {
            console.log(
                `Upstox hourly aggregate candles ${instrumentKey}:`,
                error.response?.data?.errors?.[0]?.message || error.message,
            );
        }
    }

    const unit = requestedUnit;
    const interval = requestedInterval;

    if (unit === "minutes" || unit === "hours") {
        try {
            const intraday = await fetchIntradayCandles(instrumentKey, {
                interval: unit,
                unit: interval,
            });
            if (intraday.length) return intraday;
        } catch (error) {
            console.log(
                `Upstox intraday candles ${instrumentKey} ${unit}/${interval}:`,
                error.response?.data?.errors?.[0]?.message || error.message,
            );
        }
    }

    const { toDate, fromDate } = getDateRangeForUnit(unit);
    try {
        const candles = await fetchHistoricalCandlesByRange(
            instrumentKey,
            unit,
            interval,
            fromDate,
            toDate,
        );
        return candles.slice(-250);
    } catch (error) {
        console.log(
            `Upstox historical candles ${instrumentKey}:`,
            error.response?.data?.errors?.[0]?.message || error.message,
        );
        return [];
    }
}

async function getCandles(instrumentKey, options = {}) {
    if (!instrumentKey) return [];

    const requestedUnit = options.interval || "days";
    const requestedInterval = options.unit || "1";
    const normalizedUnit = requestedUnit;
    const normalizedInterval = requestedInterval;

    const key = `${instrumentKey}:${normalizedUnit}:${normalizedInterval}`;
    const cached = candleCache.get(key);

    const ttlMs =
        requestedUnit === "minutes" || requestedUnit === "hours"
            ? INTRADAY_CANDLE_TTL_MS
            : CANDLE_TTL_MS;

    if (cached && Date.now() - cached.updatedAt < ttlMs) {
        return cached.candles;
    }

    try {
        const candles = await fetchHistoricalCandles(instrumentKey, options);
        candleCache.set(key, {
            updatedAt: Date.now(),
            candles,
        });
        return candles;
    } catch {
        return [];
    }
}

async function warmCandles(instrumentKeys = []) {
    const uniqueKeys = [...new Set(instrumentKeys.filter(Boolean))];
    const jobs = [];

    uniqueKeys.forEach((key) => {
        RSI_CANDLE_CONFIGS.forEach((cfg) => {
            jobs.push(getCandles(key, cfg).catch(() => []));
        });
    });

    await Promise.allSettled(jobs);
}

module.exports = {
    getCandles,
    warmCandles,
    RSI_CANDLE_CONFIGS,
};
