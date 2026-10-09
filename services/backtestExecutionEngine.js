/**
 * Phase D — event-driven backtest execution engine for the professional
 * platform (StrategyVersion.definition + Phase C's StrategyContext). This
 * is a NEW, separate engine from the legacy `utils/backtestEngine.js`
 * (untouched, still serves Strategy.js's flat-condition strategies) — per
 * ADR-005/the architecture audit, the two coexist rather than one being
 * rewritten in place.
 *
 * Execution model (ADR-002 + the SL/TP ambiguity policy, ADR-004):
 *
 *  - Entry/exit SIGNALS are detected on bar i's close, filled at bar i+1's
 *    open. This is the one rule carried over unchanged from the legacy
 *    engine (it was already correct/no-look-ahead there).
 *  - Stop-loss/take-profit are different: once a position is open, they
 *    are continuously-resting orders, checked against EVERY subsequent
 *    bar's high/low (including the entry bar itself, for the portion of
 *    that bar after the open fill) and fill AT THE THRESHOLD PRICE the
 *    moment it's touched — not at that bar's open or close. This is a
 *    deliberately different execution-price rule from signal exits, and
 *    is the realistic convention for a resting stop/limit order.
 *  - If a single bar's [low, high] range contains BOTH the stop and the
 *    target price, the ambiguity is resolved conservatively: the STOP
 *    always wins, regardless of numeric distance from the open. Upstox
 *    provides OHLC only, never intrabar tick sequencing, so there is no
 *    way to know which threshold actually hit first — any other policy
 *    would be an optimistic guess that overstates performance.
 *
 * Position sizing in this phase is percent-of-equity only (matching the
 * legacy engine's existing default behavior) — Phase E adds fixed-
 * quantity/fixed-cash/risk-percent modes on top of this same loop.
 * Trailing stop is an explicit, intentional no-op here: Phase B's risk
 * DSL has no trailingStop field yet, so there is nothing valid to
 * configure it from — adding trailing-stop execution logic ahead of its
 * DSL representation would be exactly the kind of speculative feature the
 * project rules warn against.
 */

const { evaluateProfessionalExpression } = require("../utils/strategyExpression");

function applySlippage(price, side, slippagePct) {
    const slip = slippagePct / 100;
    return side === "buy" ? price * (1 + slip) : price * (1 - slip);
}

/**
 * Phase E — four sizing modes, all driven by the strategy's own
 * `execution.positionSizing` config (validated in Phase B's
 * validateStrategyDefinition) rather than hardcoded in the engine:
 *
 *  - percentOfEquity: value% of current equity, in shares (legacy default).
 *  - fixedQuantity: exactly `value` units, regardless of equity/price.
 *  - fixedCash: `value` currency units worth, in shares, regardless of equity.
 *  - riskPercent: size so that `stopDistance * quantity` equals `value`%
 *    of equity — requires a configured stop-loss (Phase B's validator
 *    rejects riskPercent sizing without one); `stopDistance` must be
 *    passed in by the caller (it's entry-price-dependent, computed at
 *    fill time, not something this function can derive on its own).
 */
function computeQuantity(equity, fillPrice, positionSizing, { stopDistance = null } = {}) {
    const type = positionSizing?.type || "percentOfEquity";
    const value = Number(positionSizing?.value);

    if (type === "fixedQuantity") {
        return Number.isFinite(value) ? value : 0;
    }

    if (type === "fixedCash") {
        return fillPrice > 0 && Number.isFinite(value) ? value / fillPrice : 0;
    }

    if (type === "riskPercent") {
        if (!stopDistance || stopDistance <= 0 || !Number.isFinite(value)) return 0;
        const riskBudget = equity * (value / 100);
        return riskBudget / stopDistance;
    }

    // percentOfEquity (default)
    const pct = Number.isFinite(value) ? value : 100;
    const allocatedCash = equity * (pct / 100);
    return fillPrice > 0 ? allocatedCash / fillPrice : 0;
}

function roundTripCommission(entryPrice, exitPrice, quantity, commissionPct) {
    const entryNotional = entryPrice * quantity;
    const exitNotional = exitPrice * quantity;
    return ((entryNotional + exitNotional) * commissionPct) / 100;
}

/**
 * Workstream J (Live Strategy Engine) — extracted so the new live engine
 * (services/liveSignalEngine.js) can reuse the EXACT SAME stop/target price
 * math and ambiguity policy (ADR-004: stop wins on a same-bar touch) rather
 * than re-deriving it. Pure extraction, zero behavior change: these three
 * functions replace what was previously inline in runProfessionalBacktest's
 * loop body below, verified by the full pre-existing
 * backtestExecutionEngine.test.js/professionalPlatformIntegration.test.js
 * suites still passing unchanged after this refactor.
 */
function computeStopAndTargetPrices(entryPrice, stopLossPct, takeProfitPct) {
    return {
        stopPrice: stopLossPct > 0 ? entryPrice * (1 - stopLossPct / 100) : null,
        targetPrice: takeProfitPct > 0 ? entryPrice * (1 + takeProfitPct / 100) : null,
    };
}

/** Resting SL/TP orders are checked against a bar's high/low and fill AT
 *  THE THRESHOLD PRICE the instant it's touched — never that bar's open or
 *  close (see file doc comment). Returns null if neither is hit this bar. */
function checkStopAndTargetHit(candle, stopPrice, targetPrice) {
    const stopHit = stopPrice !== null && candle.low <= stopPrice;
    const targetHit = targetPrice !== null && candle.high >= targetPrice;

    if (stopHit) return { exitReason: "STOP_LOSS", exitPrice: stopPrice };
    if (targetHit) return { exitReason: "TAKE_PROFIT", exitPrice: targetPrice };
    return null;
}

/** The exact fees/P&L/return/slippage-cost arithmetic used to build every
 *  BacktestTrade record — see the file doc comment on closeTrade() below
 *  for why slippage cost is computed as raw-vs-fill price difference. */
function computeTradeEconomics({ entryPrice, entryRawPrice, exitPrice, exitRawPrice, quantity, commissionPct }) {
    const fees = roundTripCommission(entryPrice, exitPrice, quantity, commissionPct);
    const entrySlippageCost = Math.abs(entryPrice - entryRawPrice) * quantity;
    const exitSlippageCost = Math.abs(exitPrice - (exitRawPrice ?? exitPrice)) * quantity;
    const slippageCost = entrySlippageCost + exitSlippageCost;
    const grossPnl = (exitPrice - entryPrice) * quantity;
    const netPnl = grossPnl - fees;
    const returnPct = entryPrice * quantity !== 0 ? (netPnl / (entryPrice * quantity)) * 100 : 0;

    return {
        fees: Number(fees.toFixed(2)),
        grossPnl: Number(grossPnl.toFixed(2)),
        netPnl: Number(netPnl.toFixed(2)),
        returnPct: Number(returnPct.toFixed(2)),
        slippageCost: Number(slippageCost.toFixed(2)),
    };
}

/**
 * `strategy`: { entryExpression, exitExpression, risk: {stopLoss, takeProfit}, execution: {positionSizing} }
 *   — already resolved from a StrategyVersion.definition (Phase B shape).
 * `candles`: primary-timeframe OHLCV array (same source as `contexts`).
 * `contexts`: the StrategyContext sequence from Phase C's
 *   buildStrategyContextSeries, same length/index alignment as `candles`.
 * `startIndex`: from Phase B's getProfessionalWarmupBars — the engine
 *   trusts the caller to have computed this; it does not recompute warmup
 *   itself, to avoid a second, possibly-inconsistent warmup calculation.
 */
function runProfessionalBacktest({
    strategy,
    candles,
    contexts,
    startIndex,
    primaryTimeframe,
    initialCapital,
    commissionPct = 0.03,
    slippagePct = 0.05,
}) {
    if (candles.length !== contexts.length) {
        throw new Error("candles and contexts must be the same length and index-aligned");
    }

    const entryExpression = strategy.entryExpression || null;
    const exitExpression = strategy.exitExpression || null;
    const positionSizing = strategy.execution?.positionSizing || { type: "percentOfEquity", value: 100 };
    const stopLossPct = strategy.risk?.stopLoss?.value ? Number(strategy.risk.stopLoss.value) : 0;
    const takeProfitPct = strategy.risk?.takeProfit?.value ? Number(strategy.risk.takeProfit.value) : 0;

    let equity = initialCapital;
    let peakEquity = initialCapital;
    let inPosition = false;
    let entryPrice = 0;
    let entryRawPrice = 0;
    let entryDate = null;
    let quantity = 0;
    let entrySignalIndex = null;
    let pendingEntryFromBar = null;
    let pendingExitFromBar = null;
    let pendingExitReason = null;
    let exitSignalIndexForPending = null;

    const trades = [];
    const equitySeries = { timestamps: [], equity: [], drawdownPct: [], benchmarkEquity: [] };

    const firstClose = candles[startIndex]?.close || candles[0]?.close || 1;

    function markToMarketEquity(close) {
        if (!inPosition) return equity;
        const unrealizedPnl = (close - entryPrice) * quantity;
        return equity + unrealizedPnl;
    }

    function recordEquityPoint(candle) {
        const current = markToMarketEquity(candle.close);
        peakEquity = Math.max(peakEquity, current);
        const drawdownPct = peakEquity > 0 ? ((current - peakEquity) / peakEquity) * 100 : 0;
        const benchmarkEquity = (initialCapital * candle.close) / firstClose;

        equitySeries.timestamps.push(candle.date);
        equitySeries.equity.push(Number(current.toFixed(2)));
        equitySeries.drawdownPct.push(Number(drawdownPct.toFixed(2)));
        equitySeries.benchmarkEquity.push(Number(benchmarkEquity.toFixed(2)));
    }

    function closeTrade({ exitPrice, exitRawPrice, exitDate, exitReason, exitIndex, signalExitDate }) {
        // Slippage cost is the dollar difference between the fill and the
        // bar's raw price, on whichever side(s) actually had slippage
        // applied: signal-driven fills (applySlippage already applied to
        // entryPrice/exitPrice before this runs) do; SL/TP fills (where
        // exitRawPrice === exitPrice, the threshold price itself) don't —
        // see the file doc comment on why resting orders fill at the
        // threshold exactly, with no added slippage.
        const economics = computeTradeEconomics({ entryPrice, entryRawPrice, exitPrice, exitRawPrice, quantity, commissionPct });

        equity += economics.netPnl;

        trades.push({
            side: "LONG",
            quantity: Number(quantity.toFixed(6)),
            entryDate,
            exitDate,
            entryPrice: Number(entryPrice.toFixed(2)),
            exitPrice: Number(exitPrice.toFixed(2)),
            grossPnl: economics.grossPnl,
            fees: economics.fees,
            slippageCost: economics.slippageCost,
            netPnl: economics.netPnl,
            returnPct: economics.returnPct,
            holdingPeriodBars: exitIndex - entrySignalIndex,
            exitReason,
            signalEntryDate: candles[entrySignalIndex]?.date || null,
            signalExitDate: signalExitDate || null,
        });

        inPosition = false;
        entryPrice = 0;
        entryRawPrice = 0;
        entryDate = null;
        quantity = 0;
        entrySignalIndex = null;
    }

    for (let i = startIndex; i < candles.length; i += 1) {
        const candle = candles[i];

        // Step 1: execute a pending ENTRY signal from the previous bar, at
        // this bar's open.
        if (pendingEntryFromBar !== null && i === pendingEntryFromBar + 1) {
            const rawPrice = candle.open ?? candle.close;
            const fillPrice = applySlippage(rawPrice, "buy", slippagePct);
            const stopDistance = stopLossPct > 0 ? fillPrice * (stopLossPct / 100) : null;
            quantity = computeQuantity(equity, fillPrice, positionSizing, { stopDistance });
            entryPrice = fillPrice;
            entryRawPrice = rawPrice;
            entryDate = candle.date;
            inPosition = true;
            pendingEntryFromBar = null;
        }

        // Step 2: execute a pending EXIT signal from the previous bar, at
        // this bar's open.
        if (inPosition && pendingExitFromBar !== null && i === pendingExitFromBar + 1) {
            const rawPrice = candle.open ?? candle.close;
            const fillPrice = applySlippage(rawPrice, "sell", slippagePct);
            closeTrade({
                exitPrice: fillPrice,
                exitRawPrice: rawPrice,
                exitDate: candle.date,
                exitReason: pendingExitReason,
                exitIndex: i,
                signalExitDate: candles[exitSignalIndexForPending]?.date,
            });
            pendingExitFromBar = null;
            pendingExitReason = null;
            exitSignalIndexForPending = null;
        }

        // Step 3: stop-loss/take-profit are resting orders — check THIS
        // bar's high/low (including the entry bar, for the range after the
        // open fill above). Stop wins if both are touched in one bar.
        if (inPosition) {
            const { stopPrice, targetPrice } = computeStopAndTargetPrices(entryPrice, stopLossPct, takeProfitPct);
            const hit = checkStopAndTargetHit(candle, stopPrice, targetPrice);

            if (hit) {
                closeTrade({
                    exitPrice: hit.exitPrice,
                    exitRawPrice: hit.exitPrice,
                    exitDate: candle.date,
                    exitReason: hit.exitReason,
                    exitIndex: i,
                });
            }
        }

        recordEquityPoint(candle);

        // No new signals can be acted on from the last bar — there's no
        // next bar to execute them at.
        if (i >= candles.length - 1) continue;

        const current = contexts[i];
        const previous = contexts[i - 1];

        if (!inPosition && pendingEntryFromBar === null) {
            if (entryExpression && evaluateProfessionalExpression(current, previous, entryExpression, primaryTimeframe)) {
                pendingEntryFromBar = i;
                entrySignalIndex = i;
            }
        } else if (inPosition && pendingExitFromBar === null) {
            if (exitExpression && evaluateProfessionalExpression(current, previous, exitExpression, primaryTimeframe)) {
                pendingExitFromBar = i;
                pendingExitReason = "SIGNAL";
                exitSignalIndexForPending = i;
            }
        }
    }

    // Force-close any still-open position at the last available close —
    // there's no further data to resolve it against.
    if (inPosition) {
        const lastCandle = candles[candles.length - 1];
        closeTrade({
            exitPrice: lastCandle.close,
            exitRawPrice: lastCandle.close,
            exitDate: lastCandle.date,
            exitReason: "END_OF_DATA",
            exitIndex: candles.length - 1,
        });
        recordEquityPoint(lastCandle);
    }

    return {
        trades,
        equitySeries,
        finalEquity: equity,
    };
}

module.exports = {
    runProfessionalBacktest,
    applySlippage,
    computeQuantity,
    roundTripCommission,
    computeStopAndTargetPrices,
    checkStopAndTargetHit,
    computeTradeEconomics,
};
