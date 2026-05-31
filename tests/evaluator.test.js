const assert = require("assert");
const {
    evaluateCondition,
    evaluateStrategy,
} = require("../utils/strategyEvaluator");

function row(overrides = {}) {
    return {
        price: 100,
        rsi: 50,
        prevRsi: 48,
        hourlyRsi: 55,
        prevHourlyRsi: 52,
        ema20: 98,
        prevEma20: 97,
        ...overrides,
    };
}

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

console.log("Strategy evaluator — cross logic\n");

test("Crosses Above: prev A <= prev B and current A > B", () => {
    const current = row({ hourlyRsi: 56, prevHourlyRsi: 50, rsi: 54, prevRsi: 55 });
    const previous = row({ hourlyRsi: 50, rsi: 55 });

    const result = evaluateCondition(current, previous, {
        indicator: "RSI (1 Hour)",
        operator: "Crosses Above",
        compareType: "indicator",
        value: "RSI (Daily)",
    });

    assert.strictEqual(result, true);
});

test("Crosses Above: fails when already above on previous bar", () => {
    const current = row({ hourlyRsi: 58, prevHourlyRsi: 57, rsi: 55, prevRsi: 54 });
    const previous = row({ hourlyRsi: 57, rsi: 54 });

    const result = evaluateCondition(current, previous, {
        indicator: "RSI (1 Hour)",
        operator: "Crosses Above",
        compareType: "indicator",
        value: "RSI (Daily)",
    });

    assert.strictEqual(result, false);
});

test("Crosses Above: fails when still equal or below on current bar", () => {
    const current = row({ hourlyRsi: 54, prevHourlyRsi: 53, rsi: 54, prevRsi: 54 });
    const previous = row({ hourlyRsi: 53, rsi: 54 });

    const result = evaluateCondition(current, previous, {
        indicator: "RSI (1 Hour)",
        operator: "Crosses Above",
        compareType: "indicator",
        value: "RSI (Daily)",
    });

    assert.strictEqual(result, false);
});

test("Crosses Below: prev A >= prev B and current A < B", () => {
    const current = row({ rsi: 37, prevRsi: 39, hourlyRsi: 40, prevHourlyRsi: 42 });
    const previous = row({ rsi: 39, hourlyRsi: 42 });

    const result = evaluateCondition(current, previous, {
        indicator: "RSI (Daily)",
        operator: "Crosses Below",
        compareType: "value",
        value: "38",
    });

    assert.strictEqual(result, true);
});

test("Crosses Below: fails when still above threshold", () => {
    const current = row({ rsi: 40, prevRsi: 41 });
    const previous = row({ rsi: 41 });

    const result = evaluateCondition(current, previous, {
        indicator: "RSI (Daily)",
        operator: "Crosses Below",
        compareType: "value",
        value: "38",
    });

    assert.strictEqual(result, false);
});

test("Crosses Below vs indicator: prev A >= prev B and current A < B", () => {
    const current = row({ hourlyRsi: 48, prevHourlyRsi: 52, rsi: 50, prevRsi: 51 });
    const previous = row({ hourlyRsi: 52, rsi: 51 });

    const result = evaluateCondition(current, previous, {
        indicator: "RSI (1 Hour)",
        operator: "Crosses Below",
        compareType: "indicator",
        value: "RSI (Daily)",
    });

    assert.strictEqual(result, true);
});

test("Crosses Above returns false when indicator values are null", () => {
    const current = row({ hourlyRsi: null, rsi: 50 });
    const previous = row({ hourlyRsi: 45, rsi: 48 });

    const result = evaluateCondition(current, previous, {
        indicator: "RSI (1 Hour)",
        operator: "Crosses Above",
        compareType: "indicator",
        value: "RSI (Daily)",
    });

    assert.strictEqual(result, false);
});

test("evaluateStrategy AND requires all conditions", () => {
    const current = row({ rsi: 60, prevRsi: 55, hourlyRsi: 62, prevHourlyRsi: 58 });
    const previous = row({ rsi: 55, hourlyRsi: 58 });

    const result = evaluateStrategy(
        current,
        previous,
        [
            {
                indicator: "RSI (Daily)",
                operator: "Greater Than",
                compareType: "value",
                value: "50",
            },
            {
                indicator: "RSI (1 Hour)",
                operator: "Greater Than",
                compareType: "value",
                value: "50",
            },
        ],
        "AND",
    );

    assert.strictEqual(result, true);
});

console.log(`\n${passed} passed, ${failed} failed`);

if (failed > 0) {
    process.exit(1);
}
