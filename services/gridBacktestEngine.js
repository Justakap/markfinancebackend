/**
 * Grid Backtest — PAPER TRADING / HISTORICAL SIMULATION ONLY. Historical
 * replay for the dynamic-reference grid strategy, reusing the exact same
 * pure crossing/accounting engine the live simulator uses
 * (services/gridSimulatorEngine.js) — no second, subtly different
 * implementation of the grid rules. Deterministic: identical candles and
 * config always produce identical trades/balances/metrics (pure
 * functions, no Date.now(), no randomness).
 *
 * ADR-027 (.claude/state/DECISIONS.md) — ambiguous-OHLC intrabar policy:
 * a single candle's open/high/low/close alone cannot establish the real
 * intrabar price path, so a candle that could cross several grid levels
 * in either direction is genuinely ambiguous. Two modes:
 *   - Finer-grained replay: when the caller supplies finer-grained candles
 *     for the same span (fetched by services/gridBacktestService.js), each
 *     finer candle's own close is a genuine observed price, fed through
 *     the engine one at a time, chronologically — no assumption at all.
 *   - Conservative fallback: when no finer data is available, each coarse
 *     candle is expanded into a FIXED, deterministic 4-point sequence —
 *     Open -> Low -> High -> Close — fed through the engine as four
 *     synthetic sub-events (millisecond-offset timestamps, never
 *     presented to the user as real observed timestamps; the real candle
 *     timestamp is what's stored on any resulting trade). This exact
 *     order is applied unconditionally regardless of candle color — it is
 *     never chosen per-candle to produce a better or worse outcome.
 *     Every trade produced this way is flagged `assumedIntrabar: true`.
 */

const {
    createInitialGridState,
    processPriceUpdate,
    computePortfolioMetrics,
    roundPrice,
    annotateRunningState,
} = require("./gridSimulatorEngine");

const INTRABAR_POLICY = "open-low-high-close";

function offsetTimestamp(isoTimestamp, msOffset) {
    return new Date(new Date(isoTimestamp).getTime() + msOffset).toISOString();
}

/** The fixed, documented, deterministic conservative sub-event sequence for
 *  one candle when no finer-grained data is available. Never reordered
 *  based on candle color or any performance consideration. */
function buildConservativeSubEvents(candle) {
    const points = [candle.open, candle.low, candle.high, candle.close];
    return points
        .map((price, i) => ({ price, msOffset: i }))
        .filter(({ price }) => Number.isFinite(price) && price > 0);
}

/**
 * Replays a chronological candle series through the shared grid engine.
 * `isFinerGrained: true` means `candles` are genuine finer-grained
 * observed data (one engine event per candle close, no sub-expansion);
 * `false` means `candles` are the original (possibly coarser) series and
 * each one is expanded via the conservative fallback.
 *
 * Returns { state, trades, equitySeries, maxDrawdownPct, maxCapitalDeployed }.
 * `equitySeries` has exactly one point per input candle (mark-to-market
 * equity at that candle's close) — never per synthetic sub-event, so the
 * curve stays aligned to real calendar bars.
 */
function replayCandles({ config, candles, isFinerGrained }) {
    let state = createInitialGridState(config);
    const trades = [];
    const equitySeries = [];
    let peakEquity = -Infinity;
    let maxDrawdownPct = 0;
    let maxCapitalDeployed = 0;

    candles.forEach((candle) => {
        const subEvents = isFinerGrained
            ? [{ price: roundPrice(candle.close), msOffset: 0 }]
            : buildConservativeSubEvents(candle);

        subEvents.forEach(({ price, msOffset }) => {
            const eventTimestamp = offsetTimestamp(candle.timestamp, msOffset);
            const preUpdateState = { cash: state.cash, holdings: state.holdings, avgCost: state.avgCost };
            const result = processPriceUpdate({ config, state, price, eventTimestamp });
            state = result.state;
            const annotated = annotateRunningState(result.trades, preUpdateState, config.commissionPct ?? 0);
            annotated.forEach((trade) => {
                trades.push({
                    ...trade,
                    candleTimestamp: candle.timestamp,
                    eventTimestamp,
                    assumedIntrabar: !isFinerGrained,
                });
            });
            const deployed = roundPrice(state.holdings * price);
            if (deployed > maxCapitalDeployed) maxCapitalDeployed = deployed;
        });

        const { equity } = computePortfolioMetrics(state, candle.close);
        if (equity != null) {
            if (equity > peakEquity) peakEquity = equity;
            const drawdownPct = peakEquity > 0 ? ((peakEquity - equity) / peakEquity) * 100 : 0;
            if (drawdownPct > maxDrawdownPct) maxDrawdownPct = drawdownPct;
        }
        equitySeries.push({ timestamp: candle.timestamp, close: candle.close, equity });
    });

    return {
        state,
        trades,
        equitySeries,
        maxDrawdownPct: roundPrice(maxDrawdownPct),
        maxCapitalDeployed,
    };
}

/** The first candle with a valid (finite, positive) close in the series,
 *  in chronological order — never a later or fabricated value. Returns
 *  null if no valid candle exists (caller must reject the backtest). */
function findInitialReferenceCandle(candles) {
    return candles.find((c) => Number.isFinite(c?.close) && c.close > 0) || null;
}

module.exports = {
    INTRABAR_POLICY,
    buildConservativeSubEvents,
    replayCandles,
    findInitialReferenceCandle,
};
