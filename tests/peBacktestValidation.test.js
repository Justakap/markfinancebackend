const assert = require("assert");
const {
    strategyUsesPe,
    buildBacktestIndicators,
    runBacktestSimulation,
} = require("../utils/backtestEngine");

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

/** Synthetic daily candles: enough bars for RSI(14)/EMA20 warmup, with a
 *  simple oscillation so RSI actually crosses thresholds. */
function buildCandles(count = 40) {
    const candles = [];
    let price = 100;

    for (let i = 0; i < count; i += 1) {
        const wave = Math.sin(i / 3) * 4;
        price = 100 + wave + i * 0.1;

        candles.push({
            date: new Date(2024, 0, i + 1).toISOString(),
            open: price - 0.5,
            high: price + 1,
            low: price - 1,
            close: Number(price.toFixed(2)),
            volume: 1000 + i,
        });
    }

    return candles;
}

function rsiStrategy(overrides = {}) {
    return {
        logic: "AND",
        entryConditions: [
            { indicator: "RSI (Daily)", operator: "<", compareType: "value", value: "60" },
        ],
        exitConditions: [
            { indicator: "RSI (Daily)", operator: ">", compareType: "value", value: "40" },
        ],
        stopLoss: 5,
        target: 10,
        ...overrides,
    };
}

console.log("PE historical-backtest validation\n");

// Test 1: a strategy WITHOUT PE runs normally through the engine.
test("Strategy without PE: engine runs and returns a summary", () => {
    const strategy = rsiStrategy();
    assert.strictEqual(strategyUsesPe(strategy), false);

    const result = runBacktestSimulation({
        strategy,
        candles: buildCandles(),
        capital: 10000,
        interval: "1d",
    });

    assert.ok(result.summary);
    assert.ok(Array.isArray(result.trades));
});

// Test 2: a strategy WITH a PE condition is detected.
test("Strategy with PE Ratio entry condition: strategyUsesPe is true", () => {
    const strategy = rsiStrategy({
        entryConditions: [
            ...rsiStrategy().entryConditions,
            { indicator: "PE Ratio", operator: "<", compareType: "value", value: "20", nextLogic: "AND" },
        ],
    });

    assert.strictEqual(strategyUsesPe(strategy), true);
});

// Test 3: when a PE strategy is correctly rejected upstream (the route never
// fetches/forwards a current PE for it), the engine must not fabricate one —
// buildBacktestIndicators without options.pe must never stamp a non-null PE.
test("No pe option passed: historical bars never carry a fabricated PE value", () => {
    const candles = buildCandles();
    const rows = buildBacktestIndicators(candles, "1d", {}, {});

    rows.forEach((row) => {
        assert.strictEqual(row.pe, null);
    });
});

// Test 4: live/current PE passthrough (used by legitimate point-in-time
// callers, e.g. the live strategy scanner) remains unchanged.
test("Explicit pe option: still stamped on every row (live/current PE unaffected)", () => {
    const candles = buildCandles();
    const rows = buildBacktestIndicators(candles, "1d", {}, { pe: 27.5 });

    rows.forEach((row) => {
        assert.strictEqual(row.pe, 27.5);
    });
});

// Test 5: existing non-PE strategies see no regression.
test("Non-PE strategy: simulation completes without throwing, metrics present", () => {
    const strategy = rsiStrategy();
    const result = runBacktestSimulation({
        strategy,
        candles: buildCandles(60),
        capital: 10000,
        interval: "1d",
    });

    assert.ok(Number.isFinite(result.summary.finalCapital));
    assert.ok(Number.isFinite(result.summary.totalTrades));
});

// Test 6: PE must be detected regardless of where it appears — as the left
// side, as the right side of a compareType "indicator" condition, only in
// exitConditions, or in a legacy flat `conditions` list. The current schema
// (Strategy.js) is a flat AND/OR chain, not a nested expression tree (that's
// Phase 2.2) — these cases cover every position the flat schema allows today.
test("PE detection: left side of an AND-chained condition", () => {
    const strategy = {
        entryConditions: [
            { indicator: "RSI (Daily)", operator: "<", compareType: "value", value: "30", nextLogic: "AND" },
            { indicator: "PE Ratio", operator: "<", compareType: "value", value: "20" },
        ],
        exitConditions: [],
    };

    assert.strictEqual(strategyUsesPe(strategy), true);
});

test("PE detection: only present in exitConditions", () => {
    const strategy = {
        entryConditions: [
            { indicator: "RSI (Daily)", operator: "<", compareType: "value", value: "30" },
        ],
        exitConditions: [
            { indicator: "PE Ratio", operator: ">", compareType: "value", value: "35" },
        ],
    };

    assert.strictEqual(strategyUsesPe(strategy), true);
});

test("PE detection: as the right-hand side of a compareType 'indicator' condition", () => {
    const strategy = {
        entryConditions: [
            {
                indicator: "EMA20",
                operator: ">",
                compareType: "indicator",
                value: "PE Ratio",
            },
        ],
        exitConditions: [],
    };

    assert.strictEqual(strategyUsesPe(strategy), true);
});

test("PE detection: legacy flat `conditions` array (no entryConditions)", () => {
    const strategy = {
        conditions: [
            { indicator: "RSI (Daily)", operator: "<", compareType: "value", value: "30", nextLogic: "OR" },
            { indicator: "PE Ratio", operator: "<", compareType: "value", value: "20" },
        ],
        exitConditions: [],
    };

    assert.strictEqual(strategyUsesPe(strategy), true);
});

test("PE detection: strategy using only RSI/EMA across entry+exit is false", () => {
    const strategy = {
        entryConditions: [
            { indicator: "RSI (Daily)", operator: "<", compareType: "value", value: "30" },
        ],
        exitConditions: [
            { indicator: "EMA20", operator: ">", compareType: "indicator", value: "EMA50" },
        ],
    };

    assert.strictEqual(strategyUsesPe(strategy), false);
});

console.log(`\n${passed} passed, ${failed} failed`);

if (failed > 0) {
    process.exit(1);
}
