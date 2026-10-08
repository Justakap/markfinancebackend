const assert = require("assert");

const {
    computeBacktestSummary,
    computeTradeMetrics,
    computeExposureMetrics,
    BARS_PER_YEAR,
} = require("../services/backtestAnalyticsService");

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

function iso(day) {
    return new Date(2024, 0, day).toISOString();
}

console.log("Phase F — Professional Analytics\n");

test("computeTradeMetrics: win rate, profit factor, expectancy on a simple fixture", () => {
    const trades = [
        { netPnl: 100, holdingPeriodBars: 2 },
        { netPnl: -50, holdingPeriodBars: 1 },
        { netPnl: 200, holdingPeriodBars: 3 },
    ];
    const metrics = computeTradeMetrics({ trades });

    assert.strictEqual(metrics.totalTrades, 3);
    assert.strictEqual(metrics.winningTrades, 2);
    assert.strictEqual(metrics.losingTrades, 1);
    assert.strictEqual(metrics.winRatePct, Number(((2 / 3) * 100).toFixed(2)));
    assert.strictEqual(metrics.profitFactor, Number((300 / 50).toFixed(2)));
    assert.strictEqual(metrics.expectancy, Number(((100 - 50 + 200) / 3).toFixed(2)));
    assert.strictEqual(metrics.largestWin, 200);
    assert.strictEqual(metrics.largestLoss, -50);
});

test("computeTradeMetrics: profitFactor is null (not Infinity) when there are no losing trades", () => {
    const metrics = computeTradeMetrics({ trades: [{ netPnl: 50, holdingPeriodBars: 1 }] });
    assert.strictEqual(metrics.profitFactor, null);
});

test("computeTradeMetrics: zero trades produces zeros, never NaN", () => {
    const metrics = computeTradeMetrics({ trades: [] });
    assert.strictEqual(metrics.totalTrades, 0);
    assert.strictEqual(metrics.winRatePct, 0);
    assert.strictEqual(metrics.expectancy, 0);
    assert.strictEqual(metrics.profitFactor, null);
    Object.values(metrics).forEach((v) => assert.ok(!Number.isNaN(v)));
});

test("computeExposureMetrics: bars inside a trade's entry/exit range count as exposed", () => {
    const equitySeries = {
        timestamps: [iso(1), iso(2), iso(3), iso(4), iso(5)],
    };
    const trades = [{ entryDate: iso(2), exitDate: iso(3) }];

    const { exposurePct } = computeExposureMetrics({ trades, equitySeries });
    assert.strictEqual(exposurePct, Number(((2 / 5) * 100).toFixed(2)));
});

test("computeBacktestSummary: full pipeline on a small deterministic equity curve", () => {
    const equitySeries = {
        timestamps: [iso(1), iso(2), iso(3), iso(4), iso(5)],
        equity: [10000, 10200, 10100, 10400, 10300],
        drawdownPct: [0, 0, -0.98, 0, -0.96],
        benchmarkEquity: [10000, 10050, 10100, 10150, 10200],
    };
    const trades = [
        {
            entryDate: iso(2),
            exitDate: iso(3),
            netPnl: 150,
            holdingPeriodBars: 1,
        },
        {
            entryDate: iso(4),
            exitDate: iso(5),
            netPnl: -100,
            holdingPeriodBars: 1,
        },
    ];

    const summary = computeBacktestSummary({
        trades,
        equitySeries,
        initialCapital: 10000,
        timeframe: "1d",
    });

    assert.strictEqual(summary.finalEquity, 10300);
    assert.strictEqual(summary.totalReturnPct, 3);
    assert.strictEqual(summary.totalTrades, 2);
    assert.strictEqual(summary.winningTrades, 1);
    assert.strictEqual(summary.losingTrades, 1);
    assert.ok(summary.maxDrawdownPct < 0);
    assert.ok(summary.buyAndHoldReturnPct > 0);
    assert.strictEqual(summary.outperformancePct, Number((summary.totalReturnPct - summary.buyAndHoldReturnPct).toFixed(2)));
    assert.ok(summary.exposurePct > 0 && summary.exposurePct <= 100);
    // Sharpe/Sortino are null-or-number, never NaN/Infinity.
    [summary.sharpeRatio, summary.sortinoRatio].forEach((v) => {
        assert.ok(v === null || (Number.isFinite(v)));
    });
});

test("CAGR is null (not Infinity/NaN) for a zero-length or single-point equity series", () => {
    const summary = computeBacktestSummary({
        trades: [],
        equitySeries: { timestamps: [iso(1)], equity: [10000], drawdownPct: [0], benchmarkEquity: [10000] },
        initialCapital: 10000,
        timeframe: "1d",
    });
    assert.strictEqual(summary.cagrPct, null);
});

test("Risk metrics use a documented, inspectable methodology (risk-free rate, bars/year)", () => {
    assert.strictEqual(BARS_PER_YEAR["1d"], 252);
    assert.strictEqual(BARS_PER_YEAR["5m"], 75 * 252);

    const summary = computeBacktestSummary({
        trades: [],
        equitySeries: {
            timestamps: [iso(1), iso(2), iso(3)],
            equity: [10000, 10100, 10050],
            drawdownPct: [0, 0, -0.5],
            benchmarkEquity: [10000, 10050, 10100],
        },
        initialCapital: 10000,
        timeframe: "1d",
    });
    assert.strictEqual(summary.riskFreeRateAssumed, 0);
});

console.log(`\n${passed} passed, ${failed} failed`);

if (failed > 0) {
    process.exit(1);
}
