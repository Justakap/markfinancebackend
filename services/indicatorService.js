const { EMA, SMA, MACD } = require("technicalindicators");
const { calculateWilderRsi } = require("../utils/indicators");
const { prepareCandlesForRsi } = require("../utils/rsiCandles");

const indicatorCache = new Map();

function closesFromCandles(candles = []) {
    return candles
        .map((candle) => Number(candle.close))
        .filter((value) => Number.isFinite(value));
}

function volumesFromCandles(candles = []) {
    return candles
        .map((candle) => Number(candle.volume))
        .filter((value) => Number.isFinite(value));
}

function cacheKey(name, instrumentKey, period, candles) {
    const last = candles[candles.length - 1];
    return `${name}:${instrumentKey}:${period}:${candles.length}:${last?.timestamp || last?.date || ""}:${last?.close || ""}`;
}

function getCached(key, compute) {
    if (indicatorCache.has(key)) return indicatorCache.get(key);
    const value = compute();
    indicatorCache.set(key, value);
    return value;
}

function roundRsi(value) {
    return value == null ? null : Number(Number(value).toFixed(2));
}

function calculateRSI(
    candles = [],
    period = 14,
    instrumentKey = "unknown",
    options = {},
) {
    const { skipCache = false } = options;
    const key = cacheKey("rsi", instrumentKey, period, candles);

    const compute = () => {
        const closes = closesFromCandles(candles);
        const values = calculateWilderRsi(closes, period).filter(
            (value) => value !== null,
        );
        const rsi = values.at(-1) ?? null;
        const prevRsi = values.at(-2) ?? null;

        return {
            rsi: roundRsi(rsi),
            prevRsi: roundRsi(prevRsi),
            rsiChange:
                rsi == null || prevRsi == null
                    ? null
                    : Number((rsi - prevRsi).toFixed(2)),
        };
    };

    if (skipCache) return compute();

    return getCached(key, compute);
}

/**
 * Zerodha/Kite-style RSI pair for a timeframe:
 * - current: Wilder RSI(14) on the forming bar (live LTP, updates every tick)
 * - prev: Wilder RSI(14) on the last fully closed bar (e.g. 5m@12:05 → prev is 12:00 close)
 */
function calculateRsiForTimeframe(
    candles = [],
    period = 14,
    instrumentKey = "unknown",
    opts = {},
) {
    const {
        interval = "days",
        unit = "1",
        ltp = null,
        includeLive = false,
        nowMs = Date.now(),
    } = opts;

    const closedSeries = prepareCandlesForRsi(candles, {
        interval,
        unit,
        includeLive: false,
        nowMs,
    });
    const closed = calculateRSI(
        closedSeries,
        period,
        `${instrumentKey}:closed:${closedSeries.length}`,
    );

    if (!includeLive || ltp == null || !Number.isFinite(Number(ltp)) || Number(ltp) <= 0) {
        return closed;
    }

    const liveSeries = prepareCandlesForRsi(candles, {
        interval,
        unit,
        includeLive: true,
        ltp: Number(ltp),
        nowMs,
    });

    const live = calculateRSI(
        liveSeries,
        period,
        `${instrumentKey}:live:${liveSeries.length}:${Number(ltp).toFixed(4)}`,
        { skipCache: true },
    );

    const prev = closed.rsi;

    return {
        rsi: live.rsi,
        prevRsi: prev,
        rsiChange:
            live.rsi == null || prev == null
                ? null
                : Number((live.rsi - prev).toFixed(2)),
    };
}

function calculateEMA(candles = [], period = 20, instrumentKey = "unknown") {
    const key = cacheKey("ema", instrumentKey, period, candles);

    return getCached(key, () => {
        const closes = closesFromCandles(candles);
        const values = EMA.calculate({ values: closes, period });
        const ema = values.at(-1);
        return ema == null ? null : Number(ema.toFixed(2));
    });
}

function calculateSMA(candles = [], period = 20, instrumentKey = "unknown") {
    const key = cacheKey("sma", instrumentKey, period, candles);

    return getCached(key, () => {
        const closes = closesFromCandles(candles);
        const values = SMA.calculate({ values: closes, period });
        const sma = values.at(-1);
        return sma == null ? null : Number(sma.toFixed(2));
    });
}

function calculateMACD(candles = [], instrumentKey = "unknown") {
    const key = cacheKey("macd", instrumentKey, "12-26-9", candles);

    return getCached(key, () => {
        const closes = closesFromCandles(candles);
        const values = MACD.calculate({
            values: closes,
            fastPeriod: 12,
            slowPeriod: 26,
            signalPeriod: 9,
            SimpleMAOscillator: false,
            SimpleMASignal: false,
        });

        return values.at(-1) || null;
    });
}

function calculateRSISeries(candles = [], period = 14) {
    const closes = closesFromCandles(candles);
    if (closes.length < period + 1) {
        return new Array(candles.length).fill(null);
    }

    const values = calculateWilderRsi(closes, period);
    const validValues = values.filter((value) => value !== null);
    const offset = candles.length - validValues.length;
    const series = new Array(candles.length).fill(null);

    validValues.forEach((value, index) => {
        series[offset + index] =
            value == null ? null : Number(Number(value).toFixed(2));
    });

    return series;
}

function calculateEMASeries(candles = [], period = 20) {
    const closes = closesFromCandles(candles);
    if (closes.length < period) {
        return new Array(candles.length).fill(null);
    }

    const values = EMA.calculate({ values: closes, period });
    const offset = candles.length - values.length;
    const series = new Array(candles.length).fill(null);

    values.forEach((value, index) => {
        series[offset + index] =
            value == null ? null : Number(Number(value).toFixed(2));
    });

    return series;
}

function calculateVolumeAverage(candles = [], period = 20, instrumentKey = "unknown") {
    const key = cacheKey("volumeAvg", instrumentKey, period, candles);

    return getCached(key, () => {
        const volumes = volumesFromCandles(candles).slice(-period);
        if (!volumes.length) return null;

        return Math.round(
            volumes.reduce((sum, volume) => sum + volume, 0) / volumes.length,
        );
    });
}

function clearIndicatorCache() {
    indicatorCache.clear();
}

module.exports = {
    calculateRSI,
    calculateRsiForTimeframe,
    calculateRSISeries,
    calculateEMA,
    calculateEMASeries,
    calculateSMA,
    calculateMACD,
    calculateVolumeAverage,
    clearIndicatorCache,
};
