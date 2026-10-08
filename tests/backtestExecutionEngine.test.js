const assert = require("assert");

const { runProfessionalBacktest } = require("../services/backtestExecutionEngine");
const { buildStrategyContextSeries } = require("../services/indicatorEngine");
const { collectIndicatorRequirements, getProfessionalWarmupBars } = require("../utils/strategyExpression");

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
        console.error(`    ${error.message}`);
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

/** Builds a {candles, contexts} pair for a pure price-based strategy (no
 *  indicators needed) so execution-mechanics tests have full deterministic
 *  control over every bar's OHLC. */
function priceOnlyFixture(candles) {
    const contexts = candles.map((c) => ({
        "1d": { open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume, indicators: {} },
    }));
    return { candles, contexts };
}

console.log("Phase D — Event-driven Backtest Execution Engine\n");

// --- Entry/exit signal timing (ADR-002: signal at close, fill at next open) ---

test("Entry signal fires on the crossing bar's close, fills at the NEXT bar's open", () => {
    const candles = [
        bar(1, { open: 95, high: 96, low: 94, close: 95 }),
        bar(2, { open: 96, high: 102, low: 95, close: 101 }), // closes above 100 -> entry signal
        bar(3, { open: 103, high: 105, low: 102, close: 104 }), // entry fills here, at open (103)
        bar(4, { open: 104, high: 106, low: 103, close: 89 }), // closes below 90 -> exit signal
        bar(5, { open: 89, high: 90, low: 85, close: 88 }), // exit fills here, at open (89)
    ];
    const { contexts } = priceOnlyFixture(candles);

    const strategy = {
        entryExpression: cond(priceOp("close"), "CROSSES_ABOVE", constOp(100)),
        exitExpression: cond(priceOp("close"), "CROSSES_BELOW", constOp(90)),
    };

    const result = runProfessionalBacktest({
        strategy,
        candles,
        contexts,
        startIndex: 1,
        primaryTimeframe: "1d",
        initialCapital: 10000,
        commissionPct: 0,
        slippagePct: 0,
    });

    assert.strictEqual(result.trades.length, 1);
    assert.strictEqual(result.trades[0].entryDate, d(3));
    assert.strictEqual(result.trades[0].entryPrice, 103);
    assert.strictEqual(result.trades[0].exitDate, d(5));
    assert.strictEqual(result.trades[0].exitPrice, 89);
    assert.strictEqual(result.trades[0].exitReason, "SIGNAL");
});

// --- Stop loss ---

test("Stop loss triggers intrabar at the threshold price, not the bar's low", () => {
    const candles = [
        bar(1, { open: 95, high: 96, low: 94, close: 95 }),
        bar(2, { open: 96, high: 102, low: 95, close: 101 }),
        bar(3, { open: 100, high: 101, low: 99, close: 100 }), // entry fills at open=100
        bar(4, { open: 99, high: 99, low: 90, close: 98 }), // low=90 breaches a 5% stop (95)
    ];
    const { contexts } = priceOnlyFixture(candles);

    const strategy = {
        entryExpression: cond(priceOp("close"), "CROSSES_ABOVE", constOp(100)),
        risk: { stopLoss: { type: "percent", value: 5 } },
    };

    const result = runProfessionalBacktest({
        strategy,
        candles,
        contexts,
        startIndex: 1,
        primaryTimeframe: "1d",
        initialCapital: 10000,
        commissionPct: 0,
        slippagePct: 0,
    });

    assert.strictEqual(result.trades.length, 1);
    assert.strictEqual(result.trades[0].exitReason, "STOP_LOSS");
    assert.strictEqual(result.trades[0].exitPrice, 95); // 100 * 0.95, not the bar's low of 90
    assert.strictEqual(result.trades[0].exitDate, d(4));
});

// --- Take profit ---

test("Take profit triggers intrabar at the threshold price, not the bar's high", () => {
    const candles = [
        bar(1, { open: 95, high: 96, low: 94, close: 95 }),
        bar(2, { open: 96, high: 102, low: 95, close: 101 }),
        bar(3, { open: 100, high: 101, low: 99, close: 100 }), // entry at open=100
        bar(4, { open: 101, high: 112, low: 100, close: 105 }), // high=112 breaches a 5% target (105)
    ];
    const { contexts } = priceOnlyFixture(candles);

    const strategy = {
        entryExpression: cond(priceOp("close"), "CROSSES_ABOVE", constOp(100)),
        risk: { takeProfit: { type: "percent", value: 5 } },
    };

    const result = runProfessionalBacktest({
        strategy,
        candles,
        contexts,
        startIndex: 1,
        primaryTimeframe: "1d",
        initialCapital: 10000,
        commissionPct: 0,
        slippagePct: 0,
    });

    assert.strictEqual(result.trades.length, 1);
    assert.strictEqual(result.trades[0].exitReason, "TAKE_PROFIT");
    assert.strictEqual(result.trades[0].exitPrice, 105);
});

// --- ADR-004: simultaneous SL/TP ambiguity -> stop always wins ---

test("When one bar touches both SL and TP, the stop wins (conservative-pessimistic policy, ADR-004)", () => {
    const candles = [
        bar(1, { open: 95, high: 96, low: 94, close: 95 }),
        bar(2, { open: 96, high: 102, low: 95, close: 101 }),
        bar(3, { open: 100, high: 101, low: 99, close: 100 }), // entry at open=100
        bar(4, { open: 100, high: 120, low: 80, close: 100 }), // both 95 stop and 105 target are inside [80,120]
    ];
    const { contexts } = priceOnlyFixture(candles);

    const strategy = {
        entryExpression: cond(priceOp("close"), "CROSSES_ABOVE", constOp(100)),
        risk: {
            stopLoss: { type: "percent", value: 5 },
            takeProfit: { type: "percent", value: 5 },
        },
    };

    const result = runProfessionalBacktest({
        strategy,
        candles,
        contexts,
        startIndex: 1,
        primaryTimeframe: "1d",
        initialCapital: 10000,
        commissionPct: 0,
        slippagePct: 0,
    });

    assert.strictEqual(result.trades[0].exitReason, "STOP_LOSS");
    assert.strictEqual(result.trades[0].exitPrice, 95);
});

// --- Position sizing / fees / slippage ---

test("percentOfEquity sizing, commission, and slippage all apply as configured", () => {
    const candles = [
        bar(1, { open: 95, high: 96, low: 94, close: 95 }),
        bar(2, { open: 96, high: 102, low: 95, close: 101 }),
        bar(3, { open: 100, high: 101, low: 99, close: 100 }), // entry at open=100 + slippage
        bar(4, { open: 110, high: 111, low: 109, close: 85 }), // closes below 90 -> exit signal
        bar(5, { open: 110, high: 112, low: 108, close: 110 }), // exit at open=110 - slippage
    ];
    const { contexts } = priceOnlyFixture(candles);

    const strategy = {
        entryExpression: cond(priceOp("close"), "CROSSES_ABOVE", constOp(100)),
        exitExpression: cond(priceOp("close"), "CROSSES_BELOW", constOp(90)),
        execution: { positionSizing: { type: "percentOfEquity", value: 50 } },
    };

    const result = runProfessionalBacktest({
        strategy,
        candles,
        contexts,
        startIndex: 1,
        primaryTimeframe: "1d",
        initialCapital: 10000,
        commissionPct: 1,
        slippagePct: 1,
    });

    const trade = result.trades[0];
    const expectedEntryPrice = 100 * 1.01; // 1% buy slippage
    const expectedExitPrice = 110 * 0.99; // 1% sell slippage
    const expectedQuantity = (10000 * 0.5) / expectedEntryPrice;

    assert.strictEqual(trade.entryPrice, Number(expectedEntryPrice.toFixed(2)));
    assert.strictEqual(trade.exitPrice, Number(expectedExitPrice.toFixed(2)));
    assert.strictEqual(trade.quantity, Number(expectedQuantity.toFixed(6)));
    assert.ok(trade.fees > 0, "1% commission should produce nonzero fees");
    assert.ok(trade.slippageCost > 0, "1% slippage should produce nonzero slippage cost");
});

// --- End of data ---

test("A position still open at the end of the data force-closes at the last close, no slippage", () => {
    const candles = [
        bar(1, { open: 95, high: 96, low: 94, close: 95 }),
        bar(2, { open: 96, high: 102, low: 95, close: 101 }),
        bar(3, { open: 100, high: 101, low: 99, close: 100 }),
        bar(4, { open: 100, high: 101, low: 99, close: 99 }),
    ];
    const { contexts } = priceOnlyFixture(candles);

    const strategy = {
        entryExpression: cond(priceOp("close"), "CROSSES_ABOVE", constOp(100)),
        // No exit expression, no SL/TP — the position can only ever close
        // via END_OF_DATA in this fixture.
    };

    const result = runProfessionalBacktest({
        strategy,
        candles,
        contexts,
        startIndex: 1,
        primaryTimeframe: "1d",
        initialCapital: 10000,
        commissionPct: 0,
        slippagePct: 1,
    });

    assert.strictEqual(result.trades.length, 1);
    assert.strictEqual(result.trades[0].exitReason, "END_OF_DATA");
    assert.strictEqual(result.trades[0].exitPrice, 99, "forced close uses the raw last close, no slippage applied");
    assert.strictEqual(result.trades[0].exitDate, d(4));
});

// --- Equity curve / drawdown ---

test("Equity curve tracks mark-to-market value and drawdown is never positive", () => {
    const candles = [
        bar(1, { open: 95, high: 96, low: 94, close: 95 }),
        bar(2, { open: 96, high: 102, low: 95, close: 101 }),
        bar(3, { open: 100, high: 101, low: 99, close: 100 }),
        bar(4, { open: 100, high: 101, low: 80, close: 85 }),
        bar(5, { open: 85, high: 90, low: 84, close: 88 }),
    ];
    const { contexts } = priceOnlyFixture(candles);

    const strategy = {
        entryExpression: cond(priceOp("close"), "CROSSES_ABOVE", constOp(100)),
        risk: { stopLoss: { type: "percent", value: 10 } },
    };

    const result = runProfessionalBacktest({
        strategy,
        candles,
        contexts,
        startIndex: 1,
        primaryTimeframe: "1d",
        initialCapital: 10000,
        commissionPct: 0,
        slippagePct: 0,
    });

    // The equity series only covers bars from startIndex onward — bar 0 is
    // before the strategy's warmup/first eligible evaluation point.
    assert.strictEqual(result.equitySeries.equity.length, candles.length - 1);
    result.equitySeries.drawdownPct.forEach((value) => assert.ok(value <= 0));
});

// --- Reproducibility ---

test("Running the identical backtest twice produces byte-identical output", () => {
    const candles = [
        bar(1, { open: 95, high: 96, low: 94, close: 95 }),
        bar(2, { open: 96, high: 102, low: 95, close: 101 }),
        bar(3, { open: 100, high: 101, low: 99, close: 100 }),
        bar(4, { open: 100, high: 101, low: 95, close: 103 }),
        bar(5, { open: 103, high: 104, low: 85, close: 88 }),
    ];
    const { contexts } = priceOnlyFixture(candles);
    const strategy = {
        entryExpression: cond(priceOp("close"), "CROSSES_ABOVE", constOp(100)),
        risk: { stopLoss: { type: "percent", value: 5 }, takeProfit: { type: "percent", value: 8 } },
    };
    const config = {
        strategy,
        candles,
        contexts,
        startIndex: 1,
        primaryTimeframe: "1d",
        initialCapital: 10000,
        commissionPct: 0.03,
        slippagePct: 0.05,
    };

    const run1 = runProfessionalBacktest(config);
    const run2 = runProfessionalBacktest(config);

    assert.deepStrictEqual(run1, run2);
});

// --- Regression parity vs. the legacy engine (same signal-timing rule) ---

test("Regression parity: the new engine's signal timing matches the legacy engine's for an equivalent RSI strategy", () => {
    const { runBacktestSimulation, buildBacktestIndicators } = require("../utils/backtestEngine");

    const candles = [];
    for (let i = 0; i < 80; i += 1) {
        const close = 100 + Math.sin(i / 4) * 8 + i * 0.05;
        candles.push({
            date: new Date(2024, 0, 1 + i).toISOString(),
            open: close - 0.3,
            high: close + 1,
            low: close - 1,
            close,
            volume: 1000,
        });
    }

    // Legacy run: classic RSI(14) mean-reversion, no SL/TP.
    const legacyStrategy = {
        entryConditions: [{ indicator: "RSI (Daily)", operator: "Crosses Below", compareType: "value", value: "40" }],
        exitConditions: [{ indicator: "RSI (Daily)", operator: "Crosses Above", compareType: "value", value: "60" }],
        stopLoss: 0,
        target: 0,
        logic: "AND",
    };
    const legacyResult = runBacktestSimulation({
        strategy: legacyStrategy,
        candles,
        capital: 10000,
        interval: "1d",
        validationMode: false,
    });

    // New engine: the same semantics expressed in the professional DSL.
    const professionalStrategy = {
        entryExpression: cond({ type: "indicator", name: "RSI", params: { period: 14 } }, "CROSSES_BELOW", constOp(40)),
        exitExpression: cond({ type: "indicator", name: "RSI", params: { period: 14 } }, "CROSSES_ABOVE", constOp(60)),
    };
    const requirements = [
        ...require("../utils/strategyExpression").collectIndicatorRequirements(professionalStrategy.entryExpression, [], "1d"),
        ...require("../utils/strategyExpression").collectIndicatorRequirements(professionalStrategy.exitExpression, [], "1d"),
    ];
    const contexts = buildStrategyContextSeries({
        primaryTimeframe: "1d",
        candlesByTimeframe: { "1d": candles },
        requirements,
    });
    const startIndex = Math.max(
        getProfessionalWarmupBars(professionalStrategy.entryExpression, "1d"),
        getProfessionalWarmupBars(professionalStrategy.exitExpression, "1d"),
    );

    const newResult = runProfessionalBacktest({
        strategy: professionalStrategy,
        candles,
        contexts,
        startIndex,
        primaryTimeframe: "1d",
        initialCapital: 10000,
        commissionPct: 0,
        slippagePct: 0,
    });

    assert.strictEqual(
        newResult.trades.length,
        legacyResult.trades.length,
        `expected the same trade count (legacy RSI semantics vs. the professional DSL's RSI operand) — legacy had ${legacyResult.trades.length}, new engine had ${newResult.trades.length}`,
    );

    newResult.trades.forEach((trade, i) => {
        assert.strictEqual(trade.entryDate, legacyResult.trades[i].entryDate, `trade ${i} entry date mismatch`);
        assert.strictEqual(trade.exitDate, legacyResult.trades[i].exitDate, `trade ${i} exit date mismatch`);
    });
});

console.log(`\n${passed} passed, ${failed} failed`);

if (failed > 0) {
    process.exit(1);
}
