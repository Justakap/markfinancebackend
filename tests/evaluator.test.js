const assert = require('assert');
const {
    evaluateCondition,
    evaluateStrategy,
} = require('../utils/strategyEvaluator');

function approx(a, b, eps = 1e-6) { return Math.abs(a - b) < eps; }

// simple mock objects
const current = { price: 110, rsi: 55, prevRsi: 50, ema20: 100, prevEma20: 99 };
const previous = { price: 105, rsi: 50, ema20: 99 };

// Tests for operators
assert.strictEqual(evaluateCondition(current, previous, { indicator: 'Price', operator: '>', compareType: 'value', value: '100' }), true);
assert.strictEqual(evaluateCondition(current, previous, { indicator: 'Price', operator: '<', compareType: 'value', value: '200' }), true);
assert.strictEqual(evaluateCondition(current, previous, { indicator: 'RSI14', operator: '>=', compareType: 'value', value: '55' }), true);
assert.strictEqual(evaluateCondition(current, previous, { indicator: 'RSI14', operator: '=', compareType: 'value', value: '55' }), true);

// Crosses Above (indicator vs value)
assert.strictEqual(evaluateCondition(current, previous, { indicator: 'RSI14', operator: 'Crosses Above', compareType: 'value', value: '52' }), true);

// Crosses Above (indicator vs indicator)
assert.strictEqual(evaluateCondition(current, previous, { indicator: 'EMA20', operator: 'Crosses Above', compareType: 'indicator', value: 'RSI14' }), false);

// evaluateStrategy AND / OR
const conds = [{ indicator: 'Price', operator: '>', compareType: 'value', value: '100' }, { indicator: 'RSI14', operator: '>', compareType: 'value', value: '40' }];
assert.strictEqual(evaluateStrategy(current, previous, conds, 'AND'), true);
assert.strictEqual(evaluateStrategy(current, previous, conds, 'OR'), true);

console.log('All evaluator tests passed');
