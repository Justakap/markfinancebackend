const assert = require("assert");

const {
    evaluateProfessionalExpression,
    collectIndicatorRequirements,
    getProfessionalWarmupBars,
    validateProfessionalNode,
    validateStrategyDefinition,
} = require("../utils/strategyExpression");
const { indicatorKey } = require("../utils/indicatorRegistry");

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

function indicatorOperand(name, params, timeframe) {
    return { type: "indicator", name, params, ...(timeframe ? { timeframe } : {}) };
}

function priceOperand(field) {
    return { type: "price", field };
}

function constantOperand(value) {
    return { type: "constant", value };
}

function condition(left, operator, right) {
    return { type: "condition", left, operator, right };
}

function row(overrides = {}) {
    return {
        open: 99,
        high: 101,
        low: 98,
        close: 100,
        volume: 1000,
        indicators: {},
        ...overrides,
    };
}

console.log("Phase B — Professional Strategy DSL\n");

// --- Operand resolution / evaluation ---

test("RSI(14) < 30 evaluates against a context row", () => {
    const rsiKey = indicatorKey("RSI", { period: 14 });
    const current = { "5m": row({ indicators: { [rsiKey]: 25 } }) };
    const node = condition(indicatorOperand("RSI", { period: 14 }), "LT", constantOperand(30));

    assert.strictEqual(evaluateProfessionalExpression(current, null, node, "5m"), true);

    const current2 = { "5m": row({ indicators: { [rsiKey]: 45 } }) };
    assert.strictEqual(evaluateProfessionalExpression(current2, null, node, "5m"), false);
});

test("EMA(20) > EMA(50) compares two indicator operands", () => {
    const ema20 = indicatorKey("EMA", { period: 20 });
    const ema50 = indicatorKey("EMA", { period: 50 });
    const current = { "1d": row({ indicators: { [ema20]: 105, [ema50]: 100 } }) };
    const node = condition(
        indicatorOperand("EMA", { period: 20 }),
        "GT",
        indicatorOperand("EMA", { period: 50 }),
    );

    assert.strictEqual(evaluateProfessionalExpression(current, null, node, "1d"), true);
});

test("Close > VWAP-style price-vs-indicator comparison (using a price operand)", () => {
    const ema20 = indicatorKey("EMA", { period: 20 });
    const current = { "5m": row({ close: 110, indicators: { [ema20]: 100 } }) };
    const node = condition(priceOperand("close"), "GT", indicatorOperand("EMA", { period: 20 }));

    assert.strictEqual(evaluateProfessionalExpression(current, null, node, "5m"), true);
});

test("Volume > SMA-style constant comparison", () => {
    const current = { "5m": row({ volume: 5000 }) };
    const node = condition(priceOperand("volume"), "GT", constantOperand(2000));

    assert.strictEqual(evaluateProfessionalExpression(current, null, node, "5m"), true);
});

test("CROSSES_ABOVE requires both current and previous rows", () => {
    const rsiKey = indicatorKey("RSI", { period: 14 });
    const current = { "5m": row({ indicators: { [rsiKey]: 35 } }) };
    const previous = { "5m": row({ indicators: { [rsiKey]: 25 } }) };
    const node = condition(indicatorOperand("RSI", { period: 14 }), "CROSSES_ABOVE", constantOperand(30));

    assert.strictEqual(evaluateProfessionalExpression(current, previous, node, "5m"), true);
    assert.strictEqual(evaluateProfessionalExpression(current, null, node, "5m"), false, "no previous row -> never a cross");
});

test("Nested AND/OR groups evaluate recursively", () => {
    const rsiKey = indicatorKey("RSI", { period: 14 });
    const current = { "5m": row({ volume: 50, indicators: { [rsiKey]: 20 } }) };
    const tree = {
        type: "group",
        operator: "AND",
        children: [
            condition(indicatorOperand("RSI", { period: 14 }), "LT", constantOperand(30)),
            {
                type: "group",
                operator: "OR",
                children: [
                    condition(priceOperand("volume"), "GT", constantOperand(100)), // false
                    condition(priceOperand("close"), "GT", constantOperand(50)), // true
                ],
            },
        ],
    };

    assert.strictEqual(evaluateProfessionalExpression(current, null, tree, "5m"), true);
});

test("Multi-timeframe: an operand with its own timeframe reads from that context slot", () => {
    const rsiKey5m = indicatorKey("RSI", { period: 14 });
    const rsiKey15m = indicatorKey("RSI", { period: 14 });
    const current = {
        "5m": row({ indicators: { [rsiKey5m]: 25 } }),
        "15m": row({ indicators: { [rsiKey15m]: 60 } }),
    };
    const node = condition(
        indicatorOperand("RSI", { period: 14 }, "5m"),
        "LT",
        indicatorOperand("RSI", { period: 14 }, "15m"),
    );

    assert.strictEqual(evaluateProfessionalExpression(current, null, node, "5m"), true);
});

// --- Indicator requirement collection / warmup ---

test("collectIndicatorRequirements finds indicators recursively, both sides of a comparison", () => {
    const tree = {
        type: "group",
        operator: "AND",
        children: [
            condition(indicatorOperand("RSI", { period: 14 }), "LT", constantOperand(30)),
            condition(indicatorOperand("EMA", { period: 20 }), "GT", indicatorOperand("EMA", { period: 50 })),
        ],
    };
    const reqs = collectIndicatorRequirements(tree);
    assert.strictEqual(reqs.length, 3);
    assert.ok(reqs.some((r) => r.name === "RSI" && r.params.period === 14));
    assert.ok(reqs.some((r) => r.name === "EMA" && r.params.period === 20));
    assert.ok(reqs.some((r) => r.name === "EMA" && r.params.period === 50));
});

test("getProfessionalWarmupBars takes the max warmup across all referenced indicators", () => {
    const tree = condition(indicatorOperand("EMA", { period: 50 }), "GT", indicatorOperand("RSI", { period: 14 }));
    // EMA(50) warmup = 50, RSI(14) warmup = 15 -> max is 50
    assert.strictEqual(getProfessionalWarmupBars(tree), 50);
});

test("getProfessionalWarmupBars with no indicators at all returns 1", () => {
    const tree = condition(priceOperand("close"), "GT", constantOperand(100));
    assert.strictEqual(getProfessionalWarmupBars(tree), 1);
});

// --- Validation ---

test("Unregistered indicator is rejected (the legacy 'Future Indicators' bug, prevented)", () => {
    // BOLLINGER has no series implementation (Phase C registered
    // RSI/EMA/SMA/MACD/MACD_SIGNAL/VWAP only — see BLOCKERS.md) — it must
    // never be silently accepted the way the legacy UI accepted MACD/VWAP
    // before they had real series functions.
    assert.throws(
        () => validateProfessionalNode(condition(indicatorOperand("BOLLINGER", {}), "GT", constantOperand(0))),
        /not implemented yet/,
    );
});

test("Invalid operator is rejected", () => {
    assert.throws(() =>
        validateProfessionalNode({
            type: "condition",
            left: priceOperand("close"),
            operator: ">",
            right: constantOperand(100),
        }),
    );
});

test("Invalid operand type is rejected", () => {
    assert.throws(() =>
        validateProfessionalNode(condition({ type: "bogus" }, "GT", constantOperand(1))),
    );
});

test("Invalid price field is rejected", () => {
    assert.throws(() => validateProfessionalNode(condition(priceOperand("typo"), "GT", constantOperand(1))));
});

test("Invalid timeframe on an indicator operand is rejected", () => {
    assert.throws(() =>
        validateProfessionalNode(
            condition(indicatorOperand("RSI", { period: 14 }, "3m"), "LT", constantOperand(30)),
        ),
    );
});

test("Empty group is rejected", () => {
    assert.throws(() => validateProfessionalNode({ type: "group", operator: "AND", children: [] }));
});

test("Nested group within the depth limit is accepted", () => {
    let tree = condition(indicatorOperand("RSI", { period: 14 }), "LT", constantOperand(30));
    for (let i = 0; i < 5; i += 1) {
        tree = { type: "group", operator: "AND", children: [tree] };
    }
    assert.doesNotThrow(() => validateProfessionalNode(tree));
});

// --- Full strategy-definition validation ---

test("A complete, valid strategy definition passes validateStrategyDefinition", () => {
    const definition = {
        version: 2,
        name: "Momentum Strategy",
        universe: { timeframe: "5m" },
        entry: {
            type: "group",
            operator: "AND",
            children: [condition(indicatorOperand("RSI", { period: 14 }), "LT", constantOperand(30))],
        },
        exit: {
            type: "group",
            operator: "OR",
            children: [condition(indicatorOperand("RSI", { period: 14 }), "GT", constantOperand(70))],
        },
        risk: {
            stopLoss: { type: "percent", value: 2 },
            takeProfit: { type: "percent", value: 5 },
        },
        execution: {
            side: "LONG",
            positionSizing: { type: "percentOfEquity", value: 100 },
        },
    };

    assert.doesNotThrow(() => validateStrategyDefinition(definition));
});

test("Missing universe.timeframe is rejected", () => {
    assert.throws(() =>
        validateStrategyDefinition({
            version: 2,
            universe: {},
            entry: condition(priceOperand("close"), "GT", constantOperand(1)),
        }),
    );
});

test("Missing entry is rejected", () => {
    assert.throws(() =>
        validateStrategyDefinition({ version: 2, universe: { timeframe: "5m" } }),
    );
});

test("execution.side other than LONG is rejected (shorting is an explicitly deferred phase)", () => {
    assert.throws(() =>
        validateStrategyDefinition({
            version: 2,
            universe: { timeframe: "5m" },
            entry: condition(priceOperand("close"), "GT", constantOperand(1)),
            execution: { side: "SHORT" },
        }),
    );
});

test("Wrong definition schema version is rejected", () => {
    assert.throws(() =>
        validateStrategyDefinition({
            version: 1,
            universe: { timeframe: "5m" },
            entry: condition(priceOperand("close"), "GT", constantOperand(1)),
        }),
    );
});

console.log(`\n${passed} passed, ${failed} failed`);

if (failed > 0) {
    process.exit(1);
}
