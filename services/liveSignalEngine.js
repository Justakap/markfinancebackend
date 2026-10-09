/**
 * Workstream J (Live Strategy Engine) — single-completed-bar state machine.
 *
 * WHY THIS FILE EXISTS INSTEAD OF CALLING runProfessionalBacktest DIRECTLY:
 * backtestExecutionEngine.js's runProfessionalBacktest() is a pure function
 * over a whole in-memory candle array — its "pending entry/exit executes
 * at the next bar's open" state lives in local closure variables for the
 * duration of one call, and it always force-closes any still-open position
 * at the end as exitReason "END_OF_DATA" (correct for a backtest, where
 * there genuinely is no more data — WRONG for live, where the position is
 * simply still open and more bars are coming). There is no existing API to
 * call that loop "one bar at a time" with state resumable across process
 * restarts. Rather than reshape that already-tested batch loop (risking a
 * regression to the backtest path for a live-only need), this file
 * re-implements ONLY its orchestration/sequencing as an explicitly
 * resumable step function — every piece of actual math (stop/target price,
 * SL/TP hit-check, slippage, position sizing, commission, P&L/return) is
 * imported from backtestExecutionEngine.js UNCHANGED, not re-derived. See
 * ADR (Workstream J) in .claude/state/DECISIONS.md for the full reasoning
 * and the parity test (tests/liveSignalEngine.test.js) that proves this
 * step function reaches byte-identical trades to runProfessionalBacktest
 * for the same candle fixture processed bar-by-bar.
 *
 * Mirrors ADR-002 (signal at bar i close, execute at bar i+1 open) and
 * ADR-004 (stop wins on a same-bar SL/TP touch) exactly — nothing here
 * invents a new execution rule.
 */

const {
    applySlippage,
    computeQuantity,
    computeStopAndTargetPrices,
    checkStopAndTargetHit,
    computeTradeEconomics,
} = require("./backtestExecutionEngine");
const { evaluateProfessionalExpression } = require("../utils/strategyExpression");

/** Fresh state for a newly-activated runtime. `initialCapital` seeds
 *  equity exactly like runProfessionalBacktest's own starting equity. */
function createInitialEngineState(initialCapital) {
    return {
        equity: initialCapital,
        peakEquity: initialCapital,
        barsProcessed: 0,
        inPosition: false,
        entryPrice: 0,
        entryRawPrice: 0,
        entryDate: null,
        quantity: 0,
        entrySignalBarIndex: null,
        pendingEntry: false,
        pendingExit: false,
        pendingExitReason: null,
    };
}

function markToMarketEquity(engineState, close) {
    if (!engineState.inPosition) return engineState.equity;
    return engineState.equity + (close - engineState.entryPrice) * engineState.quantity;
}

/**
 * `candle`: the newly-completed bar (already verified closed by the caller
 *   via liveCandleFeed.js — this function trusts its input, it does not
 *   re-check completion itself).
 * `current`/`previous`: StrategyContext rows for this bar and the prior
 *   one (same shape indicatorEngine.js produces for backtesting).
 * `strategy`: { entryExpression, exitExpression, risk, execution } — same
 *   shape professionalBacktestService.js already builds from a
 *   StrategyVersion.definition.
 *
 * Returns `{ engineState: <next state>, events: [...] }`. Events are one of:
 *   { type: "ENTRY_FILLED", price, quantity, date }
 *   { type: "EXIT_FILLED", price, quantity, date, exitReason, ...economics }
 *   { type: "ENTRY_SIGNAL", date }
 *   { type: "EXIT_SIGNAL", date, exitReason }
 */
function processCompletedBar({ engineState, strategy, candle, current, previous, primaryTimeframe, commissionPct, slippagePct }) {
    const state = { ...engineState };
    const events = [];

    const entryExpression = strategy.entryExpression || null;
    const exitExpression = strategy.exitExpression || null;
    const positionSizing = strategy.execution?.positionSizing || { type: "percentOfEquity", value: 100 };
    const stopLossPct = strategy.risk?.stopLoss?.value ? Number(strategy.risk.stopLoss.value) : 0;
    const takeProfitPct = strategy.risk?.takeProfit?.value ? Number(strategy.risk.takeProfit.value) : 0;

    // Step 1: fill a pending ENTRY signal (set on a prior call) at THIS
    // bar's open — mirrors runProfessionalBacktest's Step 1 exactly.
    if (state.pendingEntry && !state.inPosition) {
        const rawPrice = candle.open ?? candle.close;
        const fillPrice = applySlippage(rawPrice, "buy", slippagePct);
        const stopDistance = stopLossPct > 0 ? fillPrice * (stopLossPct / 100) : null;
        state.quantity = computeQuantity(state.equity, fillPrice, positionSizing, { stopDistance });
        state.entryPrice = fillPrice;
        state.entryRawPrice = rawPrice;
        state.entryDate = candle.date;
        state.inPosition = true;
        state.pendingEntry = false;

        events.push({ type: "ENTRY_FILLED", price: Number(fillPrice.toFixed(2)), quantity: Number(state.quantity.toFixed(6)), date: candle.date });
    }

    // Step 2: fill a pending EXIT signal at THIS bar's open.
    if (state.inPosition && state.pendingExit) {
        const rawPrice = candle.open ?? candle.close;
        const fillPrice = applySlippage(rawPrice, "sell", slippagePct);
        const economics = computeTradeEconomics({
            entryPrice: state.entryPrice,
            entryRawPrice: state.entryRawPrice,
            exitPrice: fillPrice,
            exitRawPrice: rawPrice,
            quantity: state.quantity,
            commissionPct,
        });

        state.equity += economics.netPnl;
        events.push({
            type: "EXIT_FILLED",
            price: Number(fillPrice.toFixed(2)),
            quantity: Number(state.quantity.toFixed(6)),
            date: candle.date,
            exitReason: state.pendingExitReason,
            entryPrice: Number(state.entryPrice.toFixed(2)),
            entryDate: state.entryDate,
            holdingPeriodBars: state.barsProcessed - (state.entrySignalBarIndex ?? state.barsProcessed),
            ...economics,
        });

        state.inPosition = false;
        state.entryPrice = 0;
        state.entryRawPrice = 0;
        state.entryDate = null;
        state.quantity = 0;
        state.entrySignalBarIndex = null;
        state.pendingExit = false;
        state.pendingExitReason = null;
    }

    // Step 3: stop-loss/take-profit are resting orders, checked against
    // THIS bar's high/low (including the bar a position was just filled
    // on, for the portion after the open fill) — same ambiguity policy
    // (stop wins) as backtesting, via the identical shared helper.
    if (state.inPosition) {
        const { stopPrice, targetPrice } = computeStopAndTargetPrices(state.entryPrice, stopLossPct, takeProfitPct);
        const hit = checkStopAndTargetHit(candle, stopPrice, targetPrice);

        if (hit) {
            const economics = computeTradeEconomics({
                entryPrice: state.entryPrice,
                entryRawPrice: state.entryRawPrice,
                exitPrice: hit.exitPrice,
                exitRawPrice: hit.exitPrice,
                quantity: state.quantity,
                commissionPct,
            });

            state.equity += economics.netPnl;
            events.push({
                type: "EXIT_FILLED",
                price: Number(hit.exitPrice.toFixed(2)),
                quantity: Number(state.quantity.toFixed(6)),
                date: candle.date,
                exitReason: hit.exitReason,
                entryPrice: Number(state.entryPrice.toFixed(2)),
                entryDate: state.entryDate,
                holdingPeriodBars: state.barsProcessed - (state.entrySignalBarIndex ?? state.barsProcessed),
                ...economics,
            });

            state.inPosition = false;
            state.entryPrice = 0;
            state.entryRawPrice = 0;
            state.entryDate = null;
            state.quantity = 0;
            state.entrySignalBarIndex = null;
            // A bar that closes a position via SL/TP cannot also carry a
            // still-pending exit signal forward — it's moot now.
            state.pendingExit = false;
            state.pendingExitReason = null;
        }
    }

    state.peakEquity = Math.max(state.peakEquity, markToMarketEquity(state, candle.close));

    // Step 4: evaluate for a NEW signal against this bar's close, to be
    // filled at the next completed bar's open (ADR-002) — never acted on
    // within this same call, matching backtesting's close-then-next-open
    // timing exactly.
    if (!state.inPosition && !state.pendingEntry) {
        if (entryExpression && evaluateProfessionalExpression(current, previous, entryExpression, primaryTimeframe)) {
            state.pendingEntry = true;
            state.entrySignalBarIndex = state.barsProcessed;
            events.push({ type: "ENTRY_SIGNAL", date: candle.date });
        }
    } else if (state.inPosition && !state.pendingExit) {
        if (exitExpression && evaluateProfessionalExpression(current, previous, exitExpression, primaryTimeframe)) {
            state.pendingExit = true;
            state.pendingExitReason = "SIGNAL";
            events.push({ type: "EXIT_SIGNAL", date: candle.date, exitReason: "SIGNAL" });
        }
    }

    state.barsProcessed += 1;

    return { engineState: state, events };
}

module.exports = {
    createInitialEngineState,
    markToMarketEquity,
    processCompletedBar,
};
