const { EMA, RSI, SMA, MACD } = require("technicalindicators");

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

function calculateRSI(candles = [], period = 14, instrumentKey = "unknown") {
    const key = cacheKey("rsi", instrumentKey, period, candles);

    return getCached(key, () => {
        const closes = closesFromCandles(candles);
        const values = RSI.calculate({ values: closes, period });
        const rsi = values.at(-1) ?? null;
        const prevRsi = values.at(-2) ?? null;

        return {
            rsi: rsi == null ? null : Number(rsi.toFixed(2)),
            prevRsi: prevRsi == null ? null : Number(prevRsi.toFixed(2)),
            rsiChange:
                rsi == null || prevRsi == null
                    ? null
                    : Number((rsi - prevRsi).toFixed(2)),
        };
    });
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

    const values = RSI.calculate({ values: closes, period });
    const offset = candles.length - values.length;
    const series = new Array(candles.length).fill(null);

    values.forEach((value, index) => {
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
    calculateRSISeries,
    calculateEMA,
    calculateEMASeries,
    calculateSMA,
    calculateMACD,
    calculateVolumeAverage,
    clearIndicatorCache,
};
