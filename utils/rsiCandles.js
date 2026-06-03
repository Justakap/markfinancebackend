/**
 * Prepare Upstox candle series for RSI so values align with TradingView
 * (Wilder RSI on completed bars, not a partial in-progress bar).
 */

function periodMs(interval, unit = "1") {
    if (interval === "days") return 24 * 60 * 60 * 1000;
    if (interval === "hours") return 60 * 60 * 1000;
    if (interval === "minutes") return Number(unit || 1) * 60 * 1000;
    return 24 * 60 * 60 * 1000;
}

function dropFormingCandle(candles = [], interval = "days", unit = "1") {
    if (!Array.isArray(candles) || candles.length < 2) {
        return candles || [];
    }

    const ms = periodMs(interval, unit);
    const last = candles[candles.length - 1];
    const lastTs = new Date(last.timestamp).getTime();

    if (!Number.isFinite(lastTs)) {
        return candles;
    }

    // Bar still open — exclude it (TradingView "last closed bar" mode)
    if (Date.now() - lastTs < ms * 0.9) {
        return candles.slice(0, -1);
    }

    return candles;
}

function mergeLiveIntoLatest(candles = [], ltp) {
    const price = Number(ltp);
    if (!Array.isArray(candles) || !candles.length || !Number.isFinite(price) || price <= 0) {
        return candles;
    }

    const next = candles.map((c) => ({ ...c }));
    const lastIndex = next.length - 1;
    const last = next[lastIndex];

    next[lastIndex] = {
        ...last,
        close: price,
        high: Number.isFinite(last.high) ? Math.max(last.high, price) : price,
        low: Number.isFinite(last.low) ? Math.min(last.low, price) : price,
    };

    return next;
}

function appendLiveAsNewBar(candles = [], ltp) {
    const price = Number(ltp);
    if (!Array.isArray(candles) || !candles.length || !Number.isFinite(price) || price <= 0) {
        return candles;
    }

    const next = candles.map((c) => ({ ...c }));
    const last = next[next.length - 1];
    const baseClose = Number.isFinite(last.close) ? last.close : price;

    next.push({
        timestamp: new Date().toISOString(),
        open: baseClose,
        high: Math.max(baseClose, price),
        low: Math.min(baseClose, price),
        close: price,
        volume: 0,
        oi: Number.isFinite(last.oi) ? last.oi : 0,
    });

    return next.slice(-500);
}

/**
 * @param {object} opts
 * @param {boolean} opts.includeLive - merge LTP into forming bar (live watchlist only)
 */
function prepareCandlesForRsi(candles = [], opts = {}) {
    const { interval = "days", unit = "1", includeLive = false, ltp = null } = opts;

    let series = dropFormingCandle(candles, interval, unit);

    if (!includeLive || !Number.isFinite(Number(ltp)) || Number(ltp) <= 0) {
        return series;
    }

    if (interval === "days") {
        return appendLiveAsNewBar(series, ltp);
    }

    return mergeLiveIntoLatest(series, ltp);
}

module.exports = {
    periodMs,
    dropFormingCandle,
    prepareCandlesForRsi,
    mergeLiveIntoLatest,
    appendLiveAsNewBar,
};
