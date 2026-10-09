/**
 * Workstream J (Live Strategy Engine) — the ONLY place the live engine
 * reads candle data from. Reuses the exact same candle-completion
 * mechanism the backtest path already relies on
 * (utils/backtestEngine.js's fetchCandleSeriesForBacktest ->
 * utils/rsiCandles.js's dropFormingCandle, verified directly in
 * tests/rsiCandles.test.js this milestone) rather than inventing new
 * boundary math — see .claude/state/DECISIONS.md for the ADR.
 *
 * Deliberately does NOT call fetchCandleSeriesForBacktest itself:
 * that function memoizes forever in a process-lifetime Map keyed only by
 * (instrumentKey, timeframe, days) — correct for a one-shot backtest
 * request, but it would mean every live poll after the first ever one
 * for a given instrument/timeframe returns the exact same frozen answer.
 * This module calls candleService.getCandles() directly (which DOES
 * re-fetch today's intraday data on every call, through the existing
 * Upstox queue/cache/dedup layer — nothing new) and applies
 * dropFormingCandle itself, getting the identical completed-bar
 * guarantee without the stale-forever cache.
 *
 * No new WebSocket connection, Upstox client, or retry/backoff layer is
 * introduced anywhere in this file.
 */

const { getCandles, toBacktestQuote } = require("./candleService");
const { dropFormingCandle } = require("../utils/rsiCandles");
const { INTERVAL_TO_UPSTOX } = require("../utils/backtestEngine");

/**
 * Returns only fully-closed candles for `instrumentKey`/`timeframe`,
 * newest last, normalized to the same `{date, open, high, low, close,
 * volume}` shape the backtest engine consumes.
 */
async function fetchLatestClosedCandles(instrumentKey, timeframe, { maxBars = 500 } = {}) {
    const upstox = INTERVAL_TO_UPSTOX[timeframe] || INTERVAL_TO_UPSTOX["1d"];

    const raw = await getCandles(instrumentKey, {
        interval: upstox.unit,
        unit: upstox.interval,
        maxBars,
    });

    const closed = dropFormingCandle(raw, upstox.unit, upstox.interval);

    return closed.map(toBacktestQuote).filter((candle) => Number.isFinite(candle.close));
}

module.exports = { fetchLatestClosedCandles };
