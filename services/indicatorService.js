const { EMA, SMA, MACD } = require("technicalindicators");
const { calculateWilderRsi } = require("../utils/indicators");
const { prepareCandlesForRsi } = require("../utils/rsiCandles");

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

function roundRsi(value) {
    return value == null ? null : Number(Number(value).toFixed(2));
}

function calculateRSI(candles = [], period = 14) {
    const closes = closesFromCandles(candles);
    const values = calculateWilderRsi(closes, period).filter((value) => value !== null);
    const rsi = values.at(-1) ?? null;
    const prevRsi = values.at(-2) ?? null;

    return {
        rsi: roundRsi(rsi),
        prevRsi: roundRsi(prevRsi),
        rsiChange:
            rsi == null || prevRsi == null ? null : Number((rsi - prevRsi).toFixed(2)),
    };
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
    const closed = calculateRSI(closedSeries, period);

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

    const live = calculateRSI(liveSeries, period);

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

function calculateEMA(candles = [], period = 20) {
    const closes = closesFromCandles(candles);
    const values = EMA.calculate({ values: closes, period });
    const ema = values.at(-1);
    return ema == null ? null : Number(ema.toFixed(2));
}

function calculateSMA(candles = [], period = 20) {
    const closes = closesFromCandles(candles);
    const values = SMA.calculate({ values: closes, period });
    const sma = values.at(-1);
    return sma == null ? null : Number(sma.toFixed(2));
}

function calculateMACD(candles = []) {
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

function calculateVolumeAverage(candles = [], period = 20) {
    const volumes = volumesFromCandles(candles).slice(-period);
    if (!volumes.length) return null;

    return Math.round(volumes.reduce((sum, volume) => sum + volume, 0) / volumes.length);
}

function calculateVWAP(candles = [], ltp = null, nowMs = Date.now()) {
    if (!Array.isArray(candles) || !candles.length) return null;

    const lastTimestamp = new Date(candles[candles.length - 1]?.timestamp).getTime();
    if (!Number.isFinite(lastTimestamp)) return null;

    const sessionDate = new Date(lastTimestamp).toDateString();
    const sessionCandles = candles
        .filter((candle) => new Date(candle.timestamp).toDateString() === sessionDate)
        .map((candle) => ({
            ...candle,
            open: Number(candle.open),
            high: Number(candle.high),
            low: Number(candle.low),
            close: Number(candle.close),
            volume: Number(candle.volume || 0),
        }))
        .filter(
            (candle) =>
                Number.isFinite(candle.close) &&
                Number.isFinite(candle.volume) &&
                candle.volume > 0,
        );

    if (!sessionCandles.length) return null;

    const referenceMs = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
    const currentSessionDate = new Date(referenceMs).toDateString();
    if (
        currentSessionDate === sessionDate &&
        Number.isFinite(Number(ltp)) &&
        Number(ltp) > 0
    ) {
        const last = sessionCandles[sessionCandles.length - 1];
        sessionCandles[sessionCandles.length - 1] = {
            ...last,
            close: Number(ltp),
            high: Number.isFinite(last.high) ? Math.max(last.high, Number(ltp)) : Number(ltp),
            low: Number.isFinite(last.low) ? Math.min(last.low, Number(ltp)) : Number(ltp),
        };
    }

    let totalPriceVolume = 0;
    let totalVolume = 0;

    sessionCandles.forEach((candle) => {
        const high = Number.isFinite(candle.high) ? candle.high : candle.close;
        const low = Number.isFinite(candle.low) ? candle.low : candle.close;
        const typicalPrice = (high + low + candle.close) / 3;
        totalPriceVolume += typicalPrice * candle.volume;
        totalVolume += candle.volume;
    });

    if (totalVolume <= 0) return null;

    return Number((totalPriceVolume / totalVolume).toFixed(2));
}

/**
 * Phase C additions — causal per-bar series for indicators that previously
 * only had a single-latest-value function (BLOCKER-001 in
 * .claude/state/BLOCKERS.md). Follow calculateEMASeries'/
 * calculateRSISeries' existing offset-alignment pattern: null-pad the
 * warmup period, place real values starting at the first bar where the
 * underlying library actually produces one. No bar's value is ever
 * computed using data from a later bar — each index only ever reads
 * `candles[0..index]`.
 */
function calculateSMASeries(candles = [], period = 20) {
    const closes = closesFromCandles(candles);
    if (closes.length < period) {
        return new Array(candles.length).fill(null);
    }

    const values = SMA.calculate({ values: closes, period });
    const offset = candles.length - values.length;
    const series = new Array(candles.length).fill(null);

    values.forEach((value, index) => {
        series[offset + index] = value == null ? null : Number(Number(value).toFixed(2));
    });

    return series;
}

/** Fixed 12/26/9 params, matching calculateMACD()'s existing single-value
 *  function — not parameterized yet (no caller needs a custom MACD config
 *  today; the registry can add params later without changing this shape). */
function calculateMACDSeries(candles = []) {
    const closes = closesFromCandles(candles);
    const macdValues = MACD.calculate({
        values: closes,
        fastPeriod: 12,
        slowPeriod: 26,
        signalPeriod: 9,
        SimpleMAOscillator: false,
        SimpleMASignal: false,
    });

    const offset = candles.length - macdValues.length;
    const macd = new Array(candles.length).fill(null);
    const signal = new Array(candles.length).fill(null);
    const histogram = new Array(candles.length).fill(null);

    macdValues.forEach((entry, index) => {
        macd[offset + index] = entry?.MACD != null ? Number(entry.MACD.toFixed(4)) : null;
        signal[offset + index] = entry?.signal != null ? Number(entry.signal.toFixed(4)) : null;
        histogram[offset + index] = entry?.histogram != null ? Number(entry.histogram.toFixed(4)) : null;
    });

    return { macd, signal, histogram };
}

/**
 * Session-anchored, causal VWAP series: resets at each new calendar-day
 * boundary (candle.date/candle.timestamp) and accumulates only forward —
 * bar i's VWAP uses exactly the bars from that session's open through bar
 * i, never a later bar. This is a genuinely different shape from
 * calculateVWAP() above (which is "now, as of this instant, possibly
 * blended with a live LTP") — this is the bar-by-bar historical series a
 * backtest/chart-overlay needs instead.
 */
function calculateVWAPSeries(candles = []) {
    const series = new Array(candles.length).fill(null);
    let sessionKey = null;
    let cumulativePriceVolume = 0;
    let cumulativeVolume = 0;

    candles.forEach((candle, index) => {
        const ts = candle.date ?? candle.timestamp;
        const day = ts ? new Date(ts).toDateString() : null;

        if (day !== sessionKey) {
            sessionKey = day;
            cumulativePriceVolume = 0;
            cumulativeVolume = 0;
        }

        const close = Number(candle.close);
        const high = Number.isFinite(Number(candle.high)) ? Number(candle.high) : close;
        const low = Number.isFinite(Number(candle.low)) ? Number(candle.low) : close;
        const volume = Number(candle.volume) || 0;

        if (Number.isFinite(close) && volume > 0) {
            const typicalPrice = (high + low + close) / 3;
            cumulativePriceVolume += typicalPrice * volume;
            cumulativeVolume += volume;
        }

        series[index] = cumulativeVolume > 0 ? Number((cumulativePriceVolume / cumulativeVolume).toFixed(2)) : null;
    });

    return series;
}

function clearIndicatorCache() {
    // no-op: indicator cache removed for live accuracy
}

module.exports = {
    calculateRSI,
    calculateRsiForTimeframe,
    calculateRSISeries,
    calculateEMA,
    calculateEMASeries,
    calculateSMA,
    calculateSMASeries,
    calculateMACD,
    calculateMACDSeries,
    calculateVolumeAverage,
    calculateVWAP,
    calculateVWAPSeries,
    clearIndicatorCache,
};
