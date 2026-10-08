/**
 * Public, backward-compatible API over strategyExpression.js's primitives.
 * Kept as a separate module (rather than inlining into strategyExpression.js)
 * because existing call sites and tests import `evaluateCondition`/
 * `evaluateStrategy`/`getBacktestStartIndex` from here specifically — Phase
 * 2.2 did not rename or relocate any of this file's exports.
 */
const { getIndicatorWarmup } = require("./indicatorCatalog");
const {
    evaluateCondition,
    getIndicatorValue,
    getPreviousIndicatorValue,
    conditionsToExpression,
    evaluateExpression,
    getStrategyWarmupBars,
} = require("./strategyExpression");

/**
 * Flat-list entry point, unchanged signature and behavior. Internally this
 * now normalizes `conditions` into an expression tree and runs it through
 * the single recursive evaluator — conditionsToExpression() reproduces the
 * exact old left-to-right AND/OR fold, so every existing caller (and
 * evaluator.test.js) sees byte-identical results.
 */
function evaluateStrategy(current, previous, conditions = [], logic = "AND") {
    const expression = conditionsToExpression(conditions, logic);
    if (!expression) return false;
    return evaluateExpression(current, previous, expression);
}

/**
 * Pre-2.2 this took (entryConditions, exitConditions) flat arrays. It now
 * takes the full strategy object so it can resolve warmup bars from either
 * a new entryExpression/exitExpression tree or legacy flat conditions via
 * the single shared recursive traversal (collectStrategyIndicatorLabels).
 * Its only caller (backtestEngine.js) was updated in the same change.
 */
function getBacktestStartIndex(strategy) {
    return getStrategyWarmupBars(strategy);
}

module.exports = {
    getIndicatorValue,
    getPreviousIndicatorValue,
    evaluateCondition,
    evaluateStrategy,
    getIndicatorWarmup,
    getBacktestStartIndex,
};
