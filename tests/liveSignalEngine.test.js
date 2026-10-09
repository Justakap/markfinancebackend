/**
 * Workstream J (Live Strategy Engine) — unit + parity tests for
 * services/liveSignalEngine.js's single-bar step function. The parity
 * tests are the explicit proof the milestone asked for: feeding the SAME
 * candle fixture into the live step function one bar at a time must reach
 * the same entry/exit prices, dates, and quantities as running the whole
 * fixture through runProfessionalBacktest() in one call — because both
 * ultimately call the identical shared helpers
 * (backtestExecutionEngine.js's applySlippage/computeQuantity/
 * computeStopAndTargetPrices/checkStopAndTargetHit/computeTradeEconomics)
 * and the identical evaluator (strategyExpression.js's
 * evaluateProfessionalExpression) for every decision.
 *
 * The one deliberate, documented divergence: runProfessionalBacktest
 * force-closes any still-open position at the very end of the data
 * (exitReason "END_OF_DATA") — that rule is specific to a backtest having
 * a known, finite end. The live engine has no such concept (more bars are
 * always still coming) and correctly leaves the position open instead.
 * This is proven explicitly, not glossed over, in the last test below.
 */
const assert = require("assert");

const { runProfessionalBacktest } = require("../services/backtestExecutionEngine");
const { createInitialEngineState, processCompletedBar, markToMarketEquity } = require("../services/liveSignalEngine");

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        passed += 1;
        console.log(`  ✓ ${name}`);
    } catch (error) {
        failed += 1;
        console.error(`  ✗ ${name}`);
        console.error(`    ${error.stack || error.message}`);
    }
}

function d(day, hour = 9, minute = 15) {
    return new Date(2024, 0, day, hour, minute).toISOString();
}

function bar(day, { open, high, low, close, volume = 1000 }) {
    return { date: d(day), open, high, low, close, volume };
}

function priceOp(field) {
    return { type: "price", field };
}
function constOp(value) {
    return { type: "constant", value };
}
function cond(left, operator, right) {
    return { type: "condition", left, operator, right };
}

function priceOnlyFixture(candles) {
    return candles.map((c) => ({
        "1d": { open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume, indicators: {} },
    }));
}

/** Feeds candles[startIndex..end] one at a time into the live engine,
 *  mirroring exactly what an orchestrator would do bar-by-bar, and
 *  collects every EXIT_FILLED event as a comparable "trade" record. */
function runLiveOverFixture({ strategy, candles, contexts, startIndex, primaryTimeframe, initialCapital, commissionPct, slippagePct }) {
    let engineState = createInitialEngineState(initialCapital);
    const closedTrades = [];
    const allEvents = [];

    for (let i = startIndex; i < candles.length; i += 1) {
        const result = processCompletedBar({
            engineState,
            strategy,
            candle: candles[i],
            current: contexts[i],
            previous: contexts[i - 1],
            primaryTimeframe,
            commissionPct,
            slippagePct,
        });
        engineState = result.engineState;
        allEvents.push(...result.events);
        result.events.filter((e) => e.type === "EXIT_FILLED").forEach((e) => closedTrades.push(e));
    }

    return { engineState, closedTrades, allEvents };
}

console.log("Workstream J — liveSignalEngine (single-bar step) + backtest parity\n");

// --- Parity: a trade that closes fully within the data (no END_OF_DATA force-close involved) ---

test("Parity: identical entry/exit dates, prices, and quantities to runProfessionalBacktest for a fully-closed trade", () => {
    const candles = [
        bar(1, { open: 95, high: 96, low: 94, close: 95 }),
        bar(2, { open: 96, high: 102, low: 95, close: 101 }),
        bar(3, { open: 103, high: 105, low: 102, close: 104 }),
        bar(4, { open: 104, high: 106, low: 103, close: 89 }),
        bar(5, { open: 89, high: 90, low: 85, close: 88 }),
        bar(6, { open: 88, high: 89, low: 87, close: 88 }), // trailing bar, no new signal
    ];
    const contexts = priceOnlyFixture(candles);
    const strategy = {
        entryExpression: cond(priceOp("close"), "CROSSES_ABOVE", constOp(100)),
        exitExpression: cond(priceOp("close"), "CROSSES_BELOW", constOp(90)),
    };
    const common = { strategy, candles, contexts, startIndex: 1, primaryTimeframe: "1d", initialCapital: 10000, commissionPct: 0, slippagePct: 0 };

    const backtest = runProfessionalBacktest(common);
    const live = runLiveOverFixture(common);

    assert.strictEqual(backtest.trades.length, 1);
    assert.strictEqual(live.closedTrades.length, 1);

    assert.strictEqual(live.closedTrades[0].entryDate, backtest.trades[0].entryDate);
    assert.strictEqual(live.closedTrades[0].entryPrice, backtest.trades[0].entryPrice);
    assert.strictEqual(live.closedTrades[0].date, backtest.trades[0].exitDate);
    assert.strictEqual(live.closedTrades[0].price, backtest.trades[0].exitPrice);
    assert.strictEqual(live.closedTrades[0].quantity, backtest.trades[0].quantity);
    assert.strictEqual(live.closedTrades[0].exitReason, backtest.trades[0].exitReason);
    assert.strictEqual(live.closedTrades[0].netPnl, backtest.trades[0].netPnl);
    assert.strictEqual(live.closedTrades[0].returnPct, backtest.trades[0].returnPct);
    assert.strictEqual(live.closedTrades[0].holdingPeriodBars, backtest.trades[0].holdingPeriodBars);
});

test("Parity: stop-loss fills at the exact threshold price in both engines", () => {
    const candles = [
        bar(1, { open: 95, high: 96, low: 94, close: 95 }),
        bar(2, { open: 96, high: 102, low: 95, close: 101 }),
        bar(3, { open: 100, high: 101, low: 99, close: 100 }),
        bar(4, { open: 99, high: 99, low: 90, close: 98 }),
        bar(5, { open: 98, high: 99, low: 97, close: 98 }),
    ];
    const contexts = priceOnlyFixture(candles);
    const strategy = {
        entryExpression: cond(priceOp("close"), "CROSSES_ABOVE", constOp(100)),
        risk: { stopLoss: { type: "percent", value: 5 } },
    };
    const common = { strategy, candles, contexts, startIndex: 1, primaryTimeframe: "1d", initialCapital: 10000, commissionPct: 0, slippagePct: 0 };

    const backtest = runProfessionalBacktest(common);
    const live = runLiveOverFixture(common);

    assert.strictEqual(backtest.trades[0].exitReason, "STOP_LOSS");
    assert.strictEqual(live.closedTrades[0].exitReason, "STOP_LOSS");
    assert.strictEqual(live.closedTrades[0].price, backtest.trades[0].exitPrice);
    assert.strictEqual(live.closedTrades[0].price, 95);
});

test("Parity: commission and slippage produce identical net P&L in both engines", () => {
    const candles = [
        bar(1, { open: 95, high: 96, low: 94, close: 95 }),
        bar(2, { open: 96, high: 102, low: 95, close: 101 }),
        bar(3, { open: 103, high: 105, low: 102, close: 104 }),
        bar(4, { open: 104, high: 106, low: 103, close: 89 }),
        bar(5, { open: 89, high: 90, low: 85, close: 88 }),
    ];
    const contexts = priceOnlyFixture(candles);
    const strategy = {
        entryExpression: cond(priceOp("close"), "CROSSES_ABOVE", constOp(100)),
        exitExpression: cond(priceOp("close"), "CROSSES_BELOW", constOp(90)),
    };
    const common = { strategy, candles, contexts, startIndex: 1, primaryTimeframe: "1d", initialCapital: 10000, commissionPct: 0.03, slippagePct: 0.05 };

    const backtest = runProfessionalBacktest(common);
    const live = runLiveOverFixture(common);

    assert.strictEqual(live.closedTrades[0].netPnl, backtest.trades[0].netPnl);
    assert.strictEqual(live.closedTrades[0].fees, backtest.trades[0].fees);
    assert.strictEqual(live.closedTrades[0].slippageCost, backtest.trades[0].slippageCost);
    assert.strictEqual(live.closedTrades[0].entryPrice, backtest.trades[0].entryPrice);
});

// --- Documented divergence: END_OF_DATA force-close does not apply live ---

test("Divergence (documented, not a bug): live leaves a position OPEN where backtest force-closes it as END_OF_DATA", () => {
    const candles = [
        bar(1, { open: 95, high: 96, low: 94, close: 95 }),
        bar(2, { open: 96, high: 102, low: 95, close: 101 }), // entry signal
        bar(3, { open: 103, high: 105, low: 102, close: 104 }), // entry fills, no exit rule ever fires
    ];
    const contexts = priceOnlyFixture(candles);
    const strategy = {
        entryExpression: cond(priceOp("close"), "CROSSES_ABOVE", constOp(100)),
        // No exitExpression and no risk config — nothing will ever close
        // this position except backtesting's own end-of-data rule.
    };
    const common = { strategy, candles, contexts, startIndex: 1, primaryTimeframe: "1d", initialCapital: 10000, commissionPct: 0, slippagePct: 0 };

    const backtest = runProfessionalBacktest(common);
    const live = runLiveOverFixture(common);

    assert.strictEqual(backtest.trades.length, 1);
    assert.strictEqual(backtest.trades[0].exitReason, "END_OF_DATA");

    assert.strictEqual(live.closedTrades.length, 0, "the live engine must never fabricate a close that didn't actually happen");
    assert.strictEqual(live.engineState.inPosition, true);
    assert.strictEqual(live.engineState.entryPrice, backtest.trades[0].entryPrice);
    assert.strictEqual(live.engineState.entryDate, backtest.trades[0].entryDate);
});

// --- Single-bar step mechanics (independent of the parity comparison) ---

test("A signal detected on bar i is never filled within the same call — only on the NEXT completed bar", () => {
    let engineState = createInitialEngineState(10000);
    const candles = [bar(1, { open: 95, high: 96, low: 94, close: 95 }), bar(2, { open: 96, high: 102, low: 95, close: 101 })];
    const contexts = priceOnlyFixture(candles);
    const strategy = { entryExpression: cond(priceOp("close"), "CROSSES_ABOVE", constOp(100)) };

    const step1 = processCompletedBar({
        engineState,
        strategy,
        candle: candles[1],
        current: contexts[1],
        previous: contexts[0],
        primaryTimeframe: "1d",
        commissionPct: 0,
        slippagePct: 0,
    });

    assert.strictEqual(step1.engineState.inPosition, false);
    assert.strictEqual(step1.engineState.pendingEntry, true);
    assert.ok(step1.events.some((e) => e.type === "ENTRY_SIGNAL"));
});

test("markToMarketEquity reflects unrealized P&L while in position, and plain equity when flat", () => {
    const flatState = createInitialEngineState(10000);
    assert.strictEqual(markToMarketEquity(flatState, 999), 10000);

    const inPositionState = { ...flatState, inPosition: true, entryPrice: 100, quantity: 10 };
    assert.strictEqual(markToMarketEquity(inPositionState, 110), 10000 + (110 - 100) * 10);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
