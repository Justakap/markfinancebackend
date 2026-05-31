/**
 * TradingView-compatible indicator calculations.
 * RSI uses Wilder's smoothing (RMA). EMA uses standard exponential formula.
 */

function calculateWilderRsi(closes, period = 14) {
    if (!closes?.length) return [];

    const result = new Array(closes.length).fill(null);

    if (closes.length < period + 1) return result;

    const gains = [];
    const losses = [];

    for (let i = 1; i < closes.length; i += 1) {
        const change = closes[i] - closes[i - 1];
        gains.push(change > 0 ? change : 0);
        losses.push(change < 0 ? -change : 0);
    }

    let avgGain = 0;
    let avgLoss = 0;

    for (let i = 0; i < period; i += 1) {
        avgGain += gains[i];
        avgLoss += losses[i];
    }

    avgGain /= period;
    avgLoss /= period;

    result[period] =
        avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

    for (let i = period; i < gains.length; i += 1) {
        avgGain = (avgGain * (period - 1) + gains[i]) / period;
        avgLoss = (avgLoss * (period - 1) + losses[i]) / period;

        result[i + 1] =
            avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }

    return result;
}

function getLatestRsi(closes, period = 14) {
    const series = calculateWilderRsi(closes, period);
    const valid = series.filter((value) => value !== null);

    if (!valid.length) {
        return { rsi: null, prev: null, series };
    }

    const rsi = valid[valid.length - 1];
    const prev = valid.length >= 2 ? valid[valid.length - 2] : null;

    return { rsi, prev, series };
}

function calculateEma(closes, period) {
    if (!closes?.length || closes.length < period) return [];

    const k = 2 / (period + 1);
    const result = new Array(closes.length).fill(null);

    let sum = 0;

    for (let i = 0; i < period; i += 1) {
        sum += closes[i];
    }

    result[period - 1] = sum / period;

    for (let i = period; i < closes.length; i += 1) {
        result[i] = closes[i] * k + result[i - 1] * (1 - k);
    }

    return result;
}

function getLatestEma(closes, period) {
    const series = calculateEma(closes, period);
    const valid = series.filter((value) => value !== null);

    if (!valid.length) {
        return { ema: null, prev: null, series };
    }

    const ema = valid[valid.length - 1];
    const prev = valid.length >= 2 ? valid[valid.length - 2] : null;

    return { ema, prev, series };
}

function round2(value) {
    if (value === null || value === undefined || Number.isNaN(value)) {
        return null;
    }

    return Number(value.toFixed(2));
}

function percentDiff(a, b) {
    if (a === null || b === null || b === 0) return null;

    return Number((Math.abs((a - b) / b) * 100).toFixed(4));
}

module.exports = {
    calculateWilderRsi,
    getLatestRsi,
    calculateEma,
    getLatestEma,
    round2,
    percentDiff,
};
