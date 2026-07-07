const { dedupe } = require("../utils/requestDedup");
const { getCandles } = require("./candleService");
const { calculateRsiForTimeframe, calculateEMA, calculateVolumeAverage } = require("./indicatorService");
const { getPriceAtLookback, getPreviousDailyClose } = require("../utils/rsiCandles");

const RSI_TF_CONFIG = [
    { tf: "5m", interval: "minutes", unit: "5", key: "minute5", rsi: "rsi5m", prev: "prevRsi5m", change: "rsi5mChange" },
    { tf: "15m", interval: "minutes", unit: "15", key: "minute15", rsi: "rsi15m", prev: "prevRsi15m", change: "rsi15mChange" },
    { tf: "1h", interval: "hours", unit: "1", key: "hour1", rsi: "hourlyRsi", prev: "prevHourlyRsi", change: "hourlyRsiChange" },
    { tf: "1d", interval: "days", unit: "1", key: "daily", rsi: "rsi", prev: "prevRsi", change: "rsiChange" },
];

const bundles = new Map();

const BUNDLE_MAX_AGE_MS = Number(process.env.INDICATOR_BUNDLE_MAX_AGE_MS || 30_000);

function roundPrice(value) {
    return Number.isFinite(Number(value)) ? Number(Number(value).toFixed(2)) : null;
}

async function fetchBundleCandles(instrumentKey) {
    const [minute1, minute5, minute15, hour1, daily] = await Promise.all([
        getCandles(instrumentKey, {
            interval: "minutes",
            unit: "1",
            periodDays: 3,
            maxBars: 1000,
        }).catch(() => []),
        getCandles(instrumentKey, { interval: "minutes", unit: "5", maxBars: 500 }).catch(() => []),
        getCandles(instrumentKey, { interval: "minutes", unit: "15", maxBars: 500 }).catch(() => []),
        getCandles(instrumentKey, { interval: "hours", unit: "1", maxBars: 500 }).catch(() => []),
        getCandles(instrumentKey, { interval: "days", unit: "1", maxBars: 300 }).catch(() => []),
    ]);

    return {
        minute1,
        minute5,
        minute15,
        hour1,
        daily,
        loadedAt: Date.now(),
    };
}

async function loadInstrumentBundle(instrumentKey, { force = false } = {}) {
    if (!instrumentKey) return null;

    if (!force) {
        const existing = bundles.get(instrumentKey);
        if (existing && Date.now() - existing.loadedAt < BUNDLE_MAX_AGE_MS) {
            return existing;
        }
    }

    return dedupe(`indicator-bundle:${instrumentKey}`, async () => {
        const bundle = await fetchBundleCandles(instrumentKey);
        bundles.set(instrumentKey, bundle);
        return bundle;
    });
}

function getCachedBundle(instrumentKey) {
    return bundles.get(instrumentKey) || null;
}

function computeRsiFieldsFromBundle(bundle, instrumentKey, ltp, nowMs = Date.now()) {
    if (!bundle) return {};

    const includeLive = Number.isFinite(Number(ltp)) && Number(ltp) > 0;
    const fields = {};

    RSI_TF_CONFIG.forEach((cfg) => {
        const candles = bundle[cfg.key] || [];
        const result = calculateRsiForTimeframe(candles, 14, `${instrumentKey}:${cfg.tf}`, {
            interval: cfg.interval,
            unit: cfg.unit,
            ltp: includeLive ? Number(ltp) : null,
            includeLive,
            nowMs,
        });
        fields[cfg.rsi] = result.rsi;
        fields[cfg.prev] = result.prevRsi;
        fields[cfg.change] = result.rsiChange;
    });

    return fields;
}

function computePriceVelocityFromBundle(bundle, nowMs = Date.now()) {
    if (!bundle) {
        return {
            prevPrice5m: null,
            prevPrice15m: null,
            prevPrice1h: null,
            prevPrice: null,
        };
    }

    const referenceMs = Number.isFinite(nowMs) ? nowMs : Date.now();
    const minute1 = bundle.minute1 || [];
    const daily = bundle.daily || [];

    return {
        prevPrice5m: roundPrice(getPriceAtLookback(minute1, referenceMs, 5 * 60 * 1000)),
        prevPrice15m: roundPrice(getPriceAtLookback(minute1, referenceMs, 15 * 60 * 1000)),
        prevPrice1h: roundPrice(getPriceAtLookback(minute1, referenceMs, 60 * 60 * 1000)),
        prevPrice: roundPrice(getPreviousDailyClose(daily, referenceMs)),
    };
}

function computeEmasFromBundle(bundle, ltp) {
    if (!bundle?.daily?.length) {
        return { ema20: null, ema75: null, volAvg: null };
    }

    const daily = [...bundle.daily];
    if (Number.isFinite(Number(ltp)) && Number(ltp) > 0) {
        const last = daily[daily.length - 1];
        daily[daily.length - 1] = {
            ...last,
            close: Number(ltp),
            high: Number.isFinite(last.high) ? Math.max(last.high, Number(ltp)) : Number(ltp),
            low: Number.isFinite(last.low) ? Math.min(last.low, Number(ltp)) : Number(ltp),
        };
    }

    return {
        ema20: calculateEMA(daily, 20),
        ema75: calculateEMA(daily, 75),
        volAvg: calculateVolumeAverage(bundle.daily, 20),
    };
}

function invalidateBundle(instrumentKey) {
    bundles.delete(instrumentKey);
}

module.exports = {
    RSI_TF_CONFIG,
    loadInstrumentBundle,
    getCachedBundle,
    computeRsiFieldsFromBundle,
    computePriceVelocityFromBundle,
    computeEmasFromBundle,
    invalidateBundle,
    BUNDLE_MAX_AGE_MS,
};
