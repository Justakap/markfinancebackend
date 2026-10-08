const assert = require("assert");

const { computeQuantity } = require("../services/backtestExecutionEngine");
const { validateStrategyDefinition } = require("../utils/strategyExpression");

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

function baseDefinition(overrides = {}) {
    return {
        version: 2,
        universe: { timeframe: "1d" },
        entry: {
            type: "condition",
            left: { type: "price", field: "close" },
            operator: "GT",
            right: { type: "constant", value: 100 },
        },
        ...overrides,
    };
}

console.log("Phase E — Risk / Position Sizing / Cost Model\n");

// --- Position sizing modes ---

test("percentOfEquity: sizes to a percentage of current equity", () => {
    const qty = computeQuantity(10000, 100, { type: "percentOfEquity", value: 50 });
    assert.strictEqual(qty, 50); // 5000 / 100
});

test("fixedQuantity: ignores equity/price entirely", () => {
    const qty = computeQuantity(10000, 250, { type: "fixedQuantity", value: 37 });
    assert.strictEqual(qty, 37);
});

test("fixedCash: sizes to a fixed currency amount regardless of equity", () => {
    const qty = computeQuantity(999999, 200, { type: "fixedCash", value: 4000 });
    assert.strictEqual(qty, 20); // 4000 / 200
});

test("riskPercent: sizes so risk budget / stopDistance gives the quantity", () => {
    // 1% of 10000 equity = 100 risk budget; stop distance = 10 -> qty = 10
    const qty = computeQuantity(10000, 100, { type: "riskPercent", value: 1 }, { stopDistance: 10 });
    assert.strictEqual(qty, 10);
});

test("riskPercent: returns 0 without a stop distance (never divides by zero/undefined)", () => {
    const qty = computeQuantity(10000, 100, { type: "riskPercent", value: 1 }, {});
    assert.strictEqual(qty, 0);
});

test("Unknown sizing type falls back to the percentOfEquity formula (defensive default — Phase B's validator is what actually prevents an unknown type reaching here in practice)", () => {
    const qty = computeQuantity(10000, 100, { type: "madeUpMode", value: 999 });
    assert.strictEqual(qty, 999); // (10000 * 9.99) / 100 — percentOfEquity's formula, not a crash
});

// --- Validation: riskPercent requires a configured stop-loss ---

test("riskPercent sizing without risk.stopLoss is rejected", () => {
    assert.throws(() =>
        validateStrategyDefinition(
            baseDefinition({
                execution: { positionSizing: { type: "riskPercent", value: 1 } },
            }),
        ),
        /requires risk.stopLoss/,
    );
});

test("riskPercent sizing WITH risk.stopLoss is accepted", () => {
    assert.doesNotThrow(() =>
        validateStrategyDefinition(
            baseDefinition({
                risk: { stopLoss: { type: "percent", value: 2 } },
                execution: { positionSizing: { type: "riskPercent", value: 1 } },
            }),
        ),
    );
});

test("fixedQuantity/fixedCash sizing is accepted without a stop-loss", () => {
    assert.doesNotThrow(() =>
        validateStrategyDefinition(
            baseDefinition({ execution: { positionSizing: { type: "fixedQuantity", value: 10 } } }),
        ),
    );
    assert.doesNotThrow(() =>
        validateStrategyDefinition(
            baseDefinition({ execution: { positionSizing: { type: "fixedCash", value: 5000 } } }),
        ),
    );
});

// --- Validation: optional per-strategy cost assumptions ---

test("execution.costs within 0-5% is accepted", () => {
    assert.doesNotThrow(() =>
        validateStrategyDefinition(
            baseDefinition({ execution: { costs: { commissionPct: 0.1, slippagePct: 0.2 } } }),
        ),
    );
});

test("execution.costs outside 0-5% is rejected", () => {
    assert.throws(() =>
        validateStrategyDefinition(baseDefinition({ execution: { costs: { commissionPct: 10 } } })),
    );
    assert.throws(() =>
        validateStrategyDefinition(baseDefinition({ execution: { costs: { slippagePct: -1 } } })),
    );
});

console.log(`\n${passed} passed, ${failed} failed`);

if (failed > 0) {
    process.exit(1);
}
