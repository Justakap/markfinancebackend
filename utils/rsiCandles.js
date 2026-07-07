/**
 * Candle series for Wilder RSI aligned with Zerodha/Kite:
 * - Current RSI: forming bar (synthesized from LTP when API has not caught up)
 * - Prev RSI: last fully closed bar for that timeframe
 */

const IST = "Asia/Kolkata";

function periodMs(interval, unit = "1") {
    if (interval === "days") return 24 * 60 * 60 * 1000;
    if (interval === "hours") return 60 * 60 * 1000;
    if (interval === "minutes") return Number(unit || 1) * 60 * 1000;
    return 24 * 60 * 60 * 1000;
}

function candleOpenMs(candle) {
    const ts = new Date(candle?.timestamp).getTime();
    return Number.isFinite(ts) ? ts : null;
}

function inferStepMs(candles = [], interval = "days", unit = "1") {
    if (interval === "days") return periodMs("days", "1");

    const fallback = periodMs(interval, unit);
    if (!Array.isArray(candles) || candles.length < 2) return fallback;

    const last = candleOpenMs(candles[candles.length - 1]);
    const prev = candleOpenMs(candles[candles.length - 2]);
    if (last == null || prev == null) return fallback;

    const diff = last - prev;
    if (diff > 0) return diff;
    return fallback;
}

function getTodayStartMs(nowMs = Date.now()) {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: IST,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(new Date(nowMs));

    const y = parts.find((p) => p.type === "year")?.value;
    const m = parts.find((p) => p.type === "month")?.value;
    const d = parts.find((p) => p.type === "day")?.value;
    return new Date(`${y}-${m}-${d}T00:00:00+05:30`).getTime();
}

function getIstMinutesFromMidnight(nowMs = Date.now()) {
    const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: IST,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    }).formatToParts(new Date(nowMs));

    const hour = Number(parts.find((p) => p.type === "hour")?.value || 0);
    const minute = Number(parts.find((p) => p.type === "minute")?.value || 0);
    return hour * 60 + minute;
}

/** NSE/BSE regular cash session (IST). */
function isEquitySessionOpen(nowMs = Date.now()) {
    const minutes = getIstMinutesFromMidnight(nowMs);
    const open = 9 * 60 + 15;
    const close = 15 * 60 + 30;
    return minutes >= open && minutes < close;
}

function isSameIstDay(aMs, bMs) {
    if (aMs == null || bMs == null) return false;
    return getTodayStartMs(aMs) === getTodayStartMs(bMs);
}

function formatIstTimestamp(ms) {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: IST,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
    }).formatToParts(new Date(ms));

    const pick = (type) => parts.find((p) => p.type === type)?.value || "00";
    return `${pick("year")}-${pick("month")}-${pick("day")}T${pick("hour")}:${pick("minute")}:${pick("second")}+05:30`;
}

function candlesAsOf(candles = [], nowMs = Date.now()) {
    return (candles || []).filter((candle) => {
        const open = candleOpenMs(candle);
        return open != null && open <= nowMs;
    });
}

function cloneCandles(candles = []) {
    return (candles || []).map((c) => ({ ...c }));
}

function isBarForming(openMs, stepMs, nowMs = Date.now()) {
    if (openMs == null || !Number.isFinite(stepMs) || stepMs <= 0) return false;
    return nowMs < openMs + stepMs;
}

function makeSyntheticBar(openMs, openPrice, ltp, source = {}) {
    const price = Number(ltp);
    const open = Number.isFinite(Number(openPrice)) ? Number(openPrice) : price;

    return {
        timestamp: formatIstTimestamp(openMs),
        open,
        high: Math.max(open, price, Number(source.high) || open),
        low: Math.min(open, price, Number(source.low) || open),
        close: price,
        volume: Number(source.volume || 0),
        oi: Number.isFinite(source.oi) ? source.oi : 0,
    };
}

function mergeLiveIntoLatest(candles = [], ltp) {
    const price = Number(ltp);
    if (!Array.isArray(candles) || !candles.length || !Number.isFinite(price) || price <= 0) {
        return candles;
    }

    const next = cloneCandles(candles);
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

/** Completed bars only — strips a forming bar if the feed includes one. */
function dropFormingCandle(candles = [], interval = "days", unit = "1", nowMs = Date.now()) {
    if (!Array.isArray(candles) || candles.length < 2) {
        return cloneCandles(candles);
    }

    const stepMs = inferStepMs(candles, interval, unit);
    const lastOpen = candleOpenMs(candles[candles.length - 1]);

    if (lastOpen == null) return cloneCandles(candles);

    if (isBarForming(lastOpen, stepMs, nowMs)) {
        return cloneCandles(candles.slice(0, -1));
    }

    return cloneCandles(candles);
}

function resolveCurrentBarOpenMs(lastClosedOpenMs, stepMs, nowMs, interval) {
    if (lastClosedOpenMs == null || !Number.isFinite(stepMs) || stepMs <= 0) {
        return null;
    }

    if (interval === "days") {
        const todayStart = getTodayStartMs(nowMs);
        const lastDayStart = getTodayStartMs(lastClosedOpenMs);
        if (todayStart > lastDayStart) return todayStart;

        if (isBarForming(lastClosedOpenMs, stepMs, nowMs)) {
            return lastClosedOpenMs;
        }

        return null;
    }

    if (!isSameIstDay(lastClosedOpenMs, nowMs) || !isEquitySessionOpen(nowMs)) {
        return null;
    }

    let currentOpen = lastClosedOpenMs + stepMs;
    while (currentOpen + stepMs <= nowMs) {
        currentOpen += stepMs;
    }

    if (nowMs >= currentOpen && nowMs < currentOpen + stepMs) {
        return currentOpen;
    }

    if (isBarForming(lastClosedOpenMs, stepMs, nowMs)) {
        return lastClosedOpenMs;
    }

    return null;
}

/**
 * All fully closed bars (API data minus any in-progress bar in the feed).
 */
function buildClosedSeries(candles = [], interval = "days", unit = "1", nowMs = Date.now()) {
    return dropFormingCandle(candlesAsOf(candles, nowMs), interval, unit, nowMs);
}

/**
 * Live series for current RSI: closed history + forming bar updated with LTP.
 * Synthesizes the current bar when the API has not yet returned it.
 */
function buildLiveSeries(candles = [], opts = {}) {
    const {
        interval = "days",
        unit = "1",
        ltp = null,
        nowMs = Date.now(),
    } = opts;

    const price = Number(ltp);
    const asOf = candlesAsOf(candles, nowMs);

    if (!Array.isArray(asOf) || !asOf.length || !Number.isFinite(price) || price <= 0) {
        return buildClosedSeries(candles, interval, unit, nowMs);
    }

    const stepMs = inferStepMs(asOf, interval, unit);
    const closed = buildClosedSeries(candles, interval, unit, nowMs);

    if (!closed.length) return closed;

    const lastClosed = closed[closed.length - 1];
    const lastClosedOpen = candleOpenMs(lastClosed);
    const feedLast = asOf[asOf.length - 1];
    const feedLastOpen = candleOpenMs(feedLast);

    const currentOpen = resolveCurrentBarOpenMs(lastClosedOpen, stepMs, nowMs, interval);

    if (currentOpen == null) {
        return mergeLiveIntoLatest(closed, price);
    }

    if (feedLastOpen === currentOpen && isBarForming(feedLastOpen, stepMs, nowMs)) {
        return mergeLiveIntoLatest(cloneCandles(asOf), price);
    }

    if (feedLastOpen === currentOpen) {
        return mergeLiveIntoLatest(closed.concat([{ ...feedLast }]), price);
    }

    const seedOpen = Number.isFinite(lastClosed.close) ? lastClosed.close : price;
    return [...closed, makeSyntheticBar(currentOpen, seedOpen, price, feedLast)];
}

/**
 * @param {object} opts
 * @param {boolean} opts.includeLive
 */
function prepareCandlesForRsi(candles = [], opts = {}) {
    const { interval = "days", unit = "1", includeLive = false, ltp = null, nowMs = Date.now() } =
        opts;

    if (!includeLive || !Number.isFinite(Number(ltp)) || Number(ltp) <= 0) {
        return buildClosedSeries(candles, interval, unit, nowMs);
    }

    return buildLiveSeries(candles, {
        interval,
        unit,
        ltp: Number(ltp),
        nowMs,
    });
}

function floorToMinuteMs(value) {
    if (!Number.isFinite(value)) return null;
    return Math.floor(value / (60 * 1000)) * (60 * 1000);
}

/**
 * Price at a wall-clock lookback (e.g. tick at 12:06 → 5m prev uses the 12:01 bar).
 * Uses the 1-min candle close for the target minute; falls back to the nearest prior bar.
 */
function getPriceAtLookback(candles = [], asOfMs, lookbackMs) {
    if (!Array.isArray(candles) || !candles.length || !Number.isFinite(asOfMs)) {
        return null;
    }

    const targetMs = asOfMs - lookbackMs;
    if (!Number.isFinite(targetMs)) return null;

    const targetMinuteMs = floorToMinuteMs(targetMs);
    if (targetMinuteMs == null) return null;

    let nearestBefore = null;
    let nearestBeforeMs = -Infinity;

    for (let index = candles.length - 1; index >= 0; index -= 1) {
        const openMs = candleOpenMs(candles[index]);
        if (openMs == null) continue;

        if (openMs === targetMinuteMs) {
            const close = Number(candles[index].close);
            if (Number.isFinite(close)) return close;
            const open = Number(candles[index].open);
            if (Number.isFinite(open)) return open;
            return null;
        }

        if (openMs < targetMinuteMs && openMs > nearestBeforeMs) {
            nearestBeforeMs = openMs;
            nearestBefore = candles[index];
        }
    }

    if (nearestBefore) {
        const close = Number(nearestBefore.close);
        return Number.isFinite(close) ? close : null;
    }

    return null;
}

/** Previous trading session daily close (excludes today's bar). */
function getPreviousDailyClose(candles = [], asOfMs = Date.now()) {
    if (!Array.isArray(candles) || !candles.length) return null;

    const todayStart = getTodayStartMs(asOfMs);

    for (let index = candles.length - 1; index >= 0; index -= 1) {
        const openMs = candleOpenMs(candles[index]);
        if (openMs == null) continue;

        if (getTodayStartMs(openMs) >= todayStart) continue;

        const close = Number(candles[index].close);
        return Number.isFinite(close) ? close : null;
    }

    return null;
}

module.exports = {
    periodMs,
    inferStepMs,
    candlesAsOf,
    dropFormingCandle,
    buildClosedSeries,
    buildLiveSeries,
    prepareCandlesForRsi,
    mergeLiveIntoLatest,
    isBarForming,
    getTodayStartMs,
    floorToMinuteMs,
    getPriceAtLookback,
    getPreviousDailyClose,
};
