const assert = require("assert");

const {
    evaluateExpression,
    conditionsToExpression,
    getEntryExpression,
    getExitExpression,
    collectIndicatorLabels,
    collectStrategyIndicatorLabels,
    validateExpressionNode,
    validateExpressionTree,
    MAX_EXPRESSION_DEPTH,
    MAX_EXPRESSION_NODES,
} = require("../utils/strategyExpression");
const { evaluateStrategy, evaluateCondition } = require("../utils/strategyEvaluator");
const { strategyUsesPe, collectStrategyIndicators } = require("../utils/backtestEngine");
const {
    createStrategyRoutes,
    pickStrategyFields,
    validateStrategyPayload,
} = require("../routes/strategyRoutes");
const { requireAuth } = require("../middleware/auth");

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

function cond(indicator, operator, value, compareType = "value") {
    return { type: "condition", indicator, operator, compareType, value };
}

function row(overrides = {}) {
    return {
        price: 100,
        rsi: 50,
        prevRsi: 48,
        ema20: 98,
        prevEma20: 97,
        ema50: 95,
        prevEma50: 95,
        volume: 1000,
        pe: 18,
        ...overrides,
    };
}

console.log("Strategy expression tree (Phase 2.2)\n");

// --- 1. Simple AND group ---
test("1. Simple AND group: both true -> true, one false -> false", () => {
    const current = row({ rsi: 25, ema20: 100, prevEma20: 94, ema50: 90, prevEma50: 95 });
    const group = {
        type: "group",
        operator: "AND",
        children: [cond("RSI (Daily)", "<", "30"), cond("EMA20", ">", "EMA50", "indicator")],
    };
    assert.strictEqual(evaluateExpression(current, null, group), true);

    const falseGroup = {
        type: "group",
        operator: "AND",
        children: [cond("RSI (Daily)", "<", "30"), cond("RSI (Daily)", ">", "80")],
    };
    assert.strictEqual(evaluateExpression(current, null, falseGroup), false);
});

// --- 2. Simple OR group ---
test("2. Simple OR group: one true -> true, all false -> false", () => {
    const current = row({ rsi: 90 });
    const group = {
        type: "group",
        operator: "OR",
        children: [cond("RSI (Daily)", "<", "30"), cond("RSI (Daily)", ">", "80")],
    };
    assert.strictEqual(evaluateExpression(current, null, group), true);

    const falseGroup = {
        type: "group",
        operator: "OR",
        children: [cond("RSI (Daily)", "<", "10"), cond("RSI (Daily)", ">", "95")],
    };
    assert.strictEqual(evaluateExpression(current, null, falseGroup), false);
});

// --- 3. Nested AND inside OR ---
test("3. Nested AND inside OR: (A AND B) is false but C is true -> OR true", () => {
    const current = row({ rsi: 50, volume: 2000 });
    const tree = {
        type: "group",
        operator: "OR",
        children: [
            {
                type: "group",
                operator: "AND",
                children: [cond("RSI (Daily)", "<", "30"), cond("Volume", ">", "1500")],
            },
            cond("Volume", ">", "1500"),
        ],
    };
    assert.strictEqual(evaluateExpression(current, null, tree), true);
});

// --- 4. Nested OR inside AND ---
test("4. Nested OR inside AND: RSI<30 AND (EMA20>EMA50 OR Volume>1500)", () => {
    const current = row({ rsi: 25, ema20: 90, ema50: 95, volume: 2000 });
    const tree = {
        type: "group",
        operator: "AND",
        children: [
            cond("RSI (Daily)", "<", "30"),
            {
                type: "group",
                operator: "OR",
                children: [cond("EMA20", ">", "EMA50", "indicator"), cond("Volume", ">", "1500")],
            },
        ],
    };
    // EMA20(90) > EMA50(95) is false, but Volume(2000) > 1500 is true -> OR true -> AND true
    assert.strictEqual(evaluateExpression(current, null, tree), true);
});

// --- 5. Three-level nesting ---
test("5. Three-level nesting evaluates correctly", () => {
    const current = row({ rsi: 25, volume: 500, ema20: 100, ema50: 90 });
    const tree = {
        type: "group",
        operator: "AND",
        children: [
            cond("RSI (Daily)", "<", "30"),
            {
                type: "group",
                operator: "OR",
                children: [
                    cond("Volume", ">", "10000"), // false
                    {
                        type: "group",
                        operator: "AND",
                        children: [cond("EMA20", ">", "EMA50", "indicator"), cond("RSI (Daily)", "<", "40")],
                    },
                ],
            },
        ],
    };
    assert.strictEqual(evaluateExpression(current, null, tree), true);
});

// --- 6. Deep nesting within allowed limit ---
test("6. Deep nesting exactly at MAX_EXPRESSION_DEPTH is accepted and evaluates", () => {
    const current = row({ rsi: 10 });
    let tree = cond("RSI (Daily)", "<", "30");
    for (let i = 0; i < MAX_EXPRESSION_DEPTH; i += 1) {
        tree = { type: "group", operator: "AND", children: [tree] };
    }
    assert.doesNotThrow(() => validateExpressionTree(tree, "entry expression"));
    assert.strictEqual(evaluateExpression(current, null, tree), true);
});

// --- 7. Empty group rejected ---
test("7. Empty group rejected", () => {
    assert.throws(() => validateExpressionNode({ type: "group", operator: "AND", children: [] }));
});

// --- 8. Invalid group operator rejected ---
test("8. Invalid group operator rejected", () => {
    assert.throws(() =>
        validateExpressionNode({ type: "group", operator: "XOR", children: [cond("RSI (Daily)", "<", "30")] }),
    );
});

// --- 9. Invalid node type rejected ---
test("9. Invalid node type rejected", () => {
    assert.throws(() => validateExpressionNode({ type: "bogus" }));
});

// --- 10. Invalid condition rejected ---
test("10. Invalid condition rejected (missing indicator, bad operator)", () => {
    assert.throws(() => validateExpressionNode({ type: "condition", operator: ">", value: "30" }));
    assert.throws(() =>
        validateExpressionNode({ type: "condition", indicator: "RSI (Daily)", operator: "???", value: "30" }),
    );
    assert.throws(() =>
        validateExpressionNode({ type: "condition", indicator: "RSI (Daily)", operator: "<", value: "" }),
    );
});

// --- 11. Excessive nesting rejected ---
test("11. Excessive nesting depth rejected", () => {
    let tree = cond("RSI (Daily)", "<", "30");
    for (let i = 0; i < MAX_EXPRESSION_DEPTH + 2; i += 1) {
        tree = { type: "group", operator: "AND", children: [tree] };
    }
    assert.throws(() => validateExpressionNode(tree));
});

// --- 12. Excessive node count rejected ---
test("12. Excessive node count rejected", () => {
    const children = [];
    for (let i = 0; i < MAX_EXPRESSION_NODES + 5; i += 1) {
        children.push(cond("RSI (Daily)", "<", String(30 + i)));
    }
    const tree = { type: "group", operator: "OR", children };
    assert.throws(() => validateExpressionNode(tree));
});

// --- 13/14. Indicator collection recursive + both sides ---
test("13. Indicator collection recursively finds all indicators across nesting", () => {
    const tree = {
        type: "group",
        operator: "AND",
        children: [
            cond("RSI (Daily)", "<", "30"),
            {
                type: "group",
                operator: "OR",
                children: [cond("EMA20", ">", "EMA50", "indicator"), cond("MACD", ">", "MACD_SIGNAL", "indicator")],
            },
        ],
    };
    const labels = collectIndicatorLabels(tree);
    assert.deepStrictEqual(labels, ["RSI (Daily)", "EMA20", "EMA50", "MACD", "MACD_SIGNAL"]);
});

test("14. Indicators on both left and right sides of a comparison are discovered", () => {
    const tree = cond("EMA20", ">", "EMA50", "indicator");
    assert.deepStrictEqual(collectIndicatorLabels(tree), ["EMA20", "EMA50"]);
});

// --- 15. Legacy flat conditions normalize correctly ---
test("15. Legacy flat conditions normalize into nested left-associative binary groups", () => {
    // c0 AND c1 OR c2 (nextLogic on c0 = AND, on c1 = OR) must become
    // ((c0 AND c1) OR c2), never a flattened single group.
    const conditions = [
        { indicator: "RSI (Daily)", operator: "<", compareType: "value", value: "30", nextLogic: "AND" },
        { indicator: "EMA20", operator: ">", compareType: "indicator", value: "EMA50", nextLogic: "OR" },
        { indicator: "Volume", operator: ">", compareType: "value", value: "1000" },
    ];
    const tree = conditionsToExpression(conditions, "AND");

    assert.strictEqual(tree.type, "group");
    assert.strictEqual(tree.operator, "OR");
    assert.strictEqual(tree.children[1].type, "condition");
    assert.strictEqual(tree.children[1].indicator, "Volume");
    assert.strictEqual(tree.children[0].type, "group");
    assert.strictEqual(tree.children[0].operator, "AND");
    assert.strictEqual(tree.children[0].children[0].indicator, "RSI (Daily)");
    assert.strictEqual(tree.children[0].children[1].indicator, "EMA20");
});

// --- 16. Legacy flat strategy behavior remains unchanged ---
test("16. Legacy flat strategy produces identical signals via evaluateStrategy before/after refactor", () => {
    // Same fixture as evaluator.test.js's AND case.
    const current = row({ rsi: 60, prevRsi: 55 });
    current.hourlyRsi = 62;
    current.prevHourlyRsi = 58;
    const previous = row({ rsi: 55 });
    previous.hourlyRsi = 58;

    const result = evaluateStrategy(
        current,
        previous,
        [
            { indicator: "RSI (Daily)", operator: "Greater Than", compareType: "value", value: "50" },
            { indicator: "RSI (1 Hour)", operator: "Greater Than", compareType: "value", value: "50" },
        ],
        "AND",
    );
    assert.strictEqual(result, true);

    // Mixed AND/OR chain: cond0 AND cond1 OR cond2 should match the manual
    // left-fold, not a single flattened OR.
    const mixed = [
        { indicator: "RSI (Daily)", operator: "<", compareType: "value", value: "10", nextLogic: "AND" }, // false
        { indicator: "RSI (Daily)", operator: ">", compareType: "value", value: "10", nextLogic: "OR" }, // true
        { indicator: "RSI (Daily)", operator: "<", compareType: "value", value: "10" }, // false
    ];
    // (false AND true) OR false = false
    assert.strictEqual(evaluateStrategy(row({ rsi: 50 }), null, mixed, "AND"), false);
});

// --- 17/18. Entry/exit expression evaluation via a strategy object ---
test("17. Entry expression evaluates correctly from a strategy object", () => {
    const strategy = {
        entryExpression: {
            type: "group",
            operator: "AND",
            children: [cond("RSI (Daily)", "<", "30")],
        },
    };
    assert.strictEqual(evaluateExpression(row({ rsi: 10 }), null, getEntryExpression(strategy)), true);
    assert.strictEqual(evaluateExpression(row({ rsi: 90 }), null, getEntryExpression(strategy)), false);
});

test("18. Exit expression evaluates correctly from a strategy object", () => {
    const strategy = {
        exitExpression: {
            type: "group",
            operator: "OR",
            children: [cond("RSI (Daily)", ">", "70")],
        },
    };
    assert.strictEqual(evaluateExpression(row({ rsi: 80 }), null, getExitExpression(strategy)), true);
    assert.strictEqual(getExitExpression({}), null, "no exit rules at all -> null, not a false-evaluating tree");
});

// --- 19. Strategy serialization round-trips ---
test("19. Strategy expression round-trips through JSON (API/DB boundary) without losing fidelity", () => {
    const tree = {
        type: "group",
        operator: "AND",
        children: [
            cond("RSI (Daily)", "<", "30"),
            {
                type: "group",
                operator: "OR",
                children: [cond("EMA20", ">", "EMA50", "indicator"), cond("Volume", ">", "500")],
            },
        ],
    };
    const roundTripped = JSON.parse(JSON.stringify(tree));
    assert.deepStrictEqual(roundTripped, tree);

    const current = row({ rsi: 20, ema20: 80, ema50: 90, volume: 600 });
    assert.strictEqual(
        evaluateExpression(current, null, tree),
        evaluateExpression(current, null, roundTripped),
    );
});

// --- 20. Existing PE protection still works, including via nested expressions ---
test("20. strategyUsesPe still detects PE Ratio nested inside an expression tree", () => {
    const strategy = {
        entryExpression: {
            type: "group",
            operator: "AND",
            children: [
                cond("RSI (Daily)", "<", "30"),
                { type: "group", operator: "OR", children: [cond("PE Ratio", "<", "20")] },
            ],
        },
        exitExpression: null,
    };
    assert.strictEqual(strategyUsesPe(strategy), true);
    assert.deepStrictEqual(collectStrategyIndicators(strategy).includes("PE Ratio"), true);

    const noPe = {
        entryExpression: { type: "group", operator: "AND", children: [cond("RSI (Daily)", "<", "30")] },
    };
    assert.strictEqual(strategyUsesPe(noPe), false);
});

// --- 23. Ownership/authentication remains intact on strategy routes ---
test("23. Strategy write routes still enforce requireAuth", () => {
    const router = createStrategyRoutes({
        Strategy: {},
        Watchlist: {},
        requireAuth,
        validateObjectId: () => (req, res, next) => next(),
        rateLimit: () => true,
        runStrategyScan: async () => ({}),
        recordScanTime: () => {},
        SAMPLE_STRATEGIES: [],
        getStrategyInterval: () => "1d",
        resolveBacktestConfig: () => ({}),
        INTERVAL_CONFIG: {},
    });

    const postLayer = router.stack.find((l) => l.route?.path === "/strategies" && l.route.methods.post);
    const putLayer = router.stack.find((l) => l.route?.path === "/strategies/:id" && l.route.methods.put);

    assert.ok(postLayer.route.stack.some((l) => l.handle === requireAuth));
    assert.ok(putLayer.route.stack.some((l) => l.handle === requireAuth));
});

// --- 24/25. PUT whitelist behavior ---
test("24. pickStrategyFields strips unknown/dangerous fields (userId, _id, $set)", () => {
    const picked = pickStrategyFields({
        name: "Test",
        userId: "someone-elses-id",
        _id: "forged-id",
        $set: { userId: "hacked" },
        __proto__: { polluted: true },
        logic: "AND",
    });

    assert.strictEqual(picked.name, "Test");
    assert.strictEqual(picked.logic, "AND");
    assert.strictEqual(picked.userId, undefined);
    assert.strictEqual(picked._id, undefined);
    assert.strictEqual(picked.$set, undefined);
});

test("25. PUT-equivalent payload with a valid expression tree passes whitelist + validation", () => {
    const payload = {
        name: "Nested Strategy",
        entryExpression: {
            type: "group",
            operator: "AND",
            children: [
                cond("RSI (Daily)", "<", "30"),
                { type: "group", operator: "OR", children: [cond("EMA20", ">", "EMA50", "indicator")] },
            ],
        },
        exitExpression: null,
        userId: "should-be-dropped",
    };

    const picked = pickStrategyFields(payload);
    assert.strictEqual(picked.userId, undefined);
    assert.ok(picked.entryExpression);
    assert.doesNotThrow(() => validateStrategyPayload(picked));
});

test("25b. PUT-equivalent payload with a malformed expression tree is rejected", () => {
    const picked = pickStrategyFields({
        name: "Bad Strategy",
        entryExpression: { type: "group", operator: "AND", children: [] },
    });
    assert.throws(() => validateStrategyPayload(picked));
});

console.log(`\n${passed} passed, ${failed} failed`);
console.log("(evaluateCondition re-export sanity check)");
assert.strictEqual(typeof evaluateCondition, "function");

if (failed > 0) {
    process.exit(1);
}
