/**
 * Phase 2.2 — nested strategy expression tree.
 *
 * Two node types, deliberately minimal:
 *   GROUP:     { type: "group", operator: "AND"|"OR", children: [...] }
 *   CONDITION: { type: "condition", indicator, operator, compareType, value }
 *
 * CONDITION reuses the exact existing field names/semantics from the flat
 * condition schema (Strategy.js's conditionSchema) rather than inventing
 * left/right fields — evaluateCondition below is byte-identical to the
 * pre-Phase-2.2 implementation in strategyEvaluator.js, just relocated here
 * so both the legacy flat-list path and the new tree path share one
 * implementation with no duplication.
 *
 * Legacy strategies (`conditions`/`entryConditions`/`exitConditions` flat
 * arrays, with per-condition `nextLogic` and a strategy-level `logic`) are
 * never migrated in the database. They're normalized into an equivalent
 * expression tree in memory, at evaluation time, via conditionsToExpression()
 * — see its doc comment for why that must be a left-associative chain of
 * binary groups rather than a single flattened n-ary group.
 */

const {
    getFieldForIndicator,
    getPrevFieldForIndicator,
    getIndicatorWarmup,
    normalizeIndicatorLabel,
} = require("./indicatorCatalog");

const VALID_OPERATORS = [
    ">",
    "<",
    ">=",
    "<=",
    "=",
    "Equals",
    "Greater Than",
    "Less Than",
    "Crosses Above",
    "Crosses Below",
];

const MAX_EXPRESSION_DEPTH = Number(process.env.STRATEGY_EXPRESSION_MAX_DEPTH || 8);
const MAX_EXPRESSION_NODES = Number(process.env.STRATEGY_EXPRESSION_MAX_NODES || 200);

// --- Leaf condition evaluation (unchanged semantics from pre-2.2) ---

function readField(stock, field) {
    if (!stock || !field) return null;
    const value = stock[field];
    return value === undefined ? null : value;
}

function getIndicatorValue(stock, indicator) {
    const field = getFieldForIndicator(indicator);
    return readField(stock, field);
}

function getPreviousIndicatorValue(stock, indicator) {
    const prevField = getPrevFieldForIndicator(indicator);
    if (prevField) {
        return readField(stock, prevField);
    }
    return null;
}

function evaluateCondition(current, previous, condition) {
    const indicator = normalizeIndicatorLabel(condition.indicator);

    if (!indicator) return false;

    const left = getIndicatorValue(current, indicator);

    let prevLeft = null;

    if (previous) {
        prevLeft = getIndicatorValue(previous, indicator);
    } else {
        prevLeft = getPreviousIndicatorValue(current, indicator);
    }

    let right;
    let prevRight = null;

    if (condition.compareType === "indicator") {
        const rightIndicator = normalizeIndicatorLabel(condition.value);

        if (!rightIndicator) return false;

        right = getIndicatorValue(current, rightIndicator);

        if (previous) {
            prevRight = getIndicatorValue(previous, rightIndicator);
        } else {
            prevRight = getPreviousIndicatorValue(current, rightIndicator);
        }
    } else {
        right = Number(condition.value);
        prevRight = right;
    }

    if (left == null || right == null) return false;

    switch (condition.operator) {
        case ">":
        case "Greater Than":
            return left > right;
        case "<":
        case "Less Than":
            return left < right;
        case ">=":
            return left >= right;
        case "<=":
            return left <= right;
        case "=":
        case "Equals":
            return left === right;
        case "Crosses Above":
            if (prevLeft == null || prevRight == null) return false;
            return prevLeft <= prevRight && left > right;
        case "Crosses Below":
            if (prevLeft == null || prevRight == null) return false;
            return prevLeft >= prevRight && left < right;
        default:
            return false;
    }
}

// --- Legacy flat-list -> expression tree normalization ---

function toConditionNode(raw) {
    return {
        type: "condition",
        indicator: raw.indicator,
        operator: raw.operator,
        compareType: raw.compareType,
        value: raw.value,
    };
}

/**
 * The legacy evaluator folds conditions strictly left-to-right, where the
 * connector between condition[i] and condition[i+1] is condition[i].nextLogic
 * (falling back to the strategy-level `logic`, then "AND"). Because adjacent
 * connectors can differ (e.g. A AND B OR C), this is NOT equivalent to a
 * single n-ary group — it must become nested left-associative binary groups:
 * ((A AND B) OR C), never a flattened {operator, children:[A,B,C]}. This
 * reproduces the exact old truth table for every legacy strategy, byte for
 * byte, while still being a valid node under the GROUP/CONDITION schema.
 */
function conditionsToExpression(conditions = [], logic = "AND") {
    if (!conditions || !conditions.length) return null;

    let node = toConditionNode(conditions[0]);

    for (let i = 1; i < conditions.length; i += 1) {
        const connector = conditions[i - 1].nextLogic || logic || "AND";
        node = {
            type: "group",
            operator: connector === "OR" ? "OR" : "AND",
            children: [node, toConditionNode(conditions[i])],
        };
    }

    return node;
}

function getLegacyEntryConditions(strategy) {
    return strategy?.entryConditions?.length
        ? strategy.entryConditions
        : strategy?.conditions || [];
}

/** entryExpression (new tree field) wins if present; otherwise the legacy
 *  flat entryConditions/conditions are normalized on the fly. Entry is
 *  never optional in spirit (an empty legacy list already returned false
 *  before 2.2 and still does: conditionsToExpression returns null). */
function getEntryExpression(strategy) {
    if (strategy?.entryExpression) return strategy.entryExpression;
    return conditionsToExpression(getLegacyEntryConditions(strategy), strategy?.logic || "AND");
}

/** exitExpression (new tree field) wins if present; otherwise legacy
 *  exitConditions are normalized. Returns null when there are no exit
 *  rules at all — callers must treat null as "no exit-by-condition check",
 *  not as "always false", matching pre-2.2 call-site behavior. */
function getExitExpression(strategy) {
    if (strategy?.exitExpression) return strategy.exitExpression;
    return conditionsToExpression(strategy?.exitConditions || [], strategy?.logic || "AND");
}

// --- Single recursive evaluator ---

function evaluateExpression(current, previous, node) {
    if (!node) return false;

    if (node.type === "condition") {
        return evaluateCondition(current, previous, node);
    }

    if (node.type === "group") {
        const children = node.children || [];
        if (node.operator === "OR") {
            return children.some((child) => evaluateExpression(current, previous, child));
        }
        return children.every((child) => evaluateExpression(current, previous, child));
    }

    return false;
}

// --- Recursive indicator discovery (single reusable traversal) ---

function collectIndicatorLabels(node, acc = []) {
    if (!node) return acc;

    if (node.type === "condition") {
        if (node.indicator) acc.push(node.indicator);
        if (node.compareType === "indicator" && node.value) acc.push(node.value);
        return acc;
    }

    if (node.type === "group") {
        (node.children || []).forEach((child) => collectIndicatorLabels(child, acc));
    }

    return acc;
}

function collectStrategyIndicatorLabels(strategy) {
    const labels = [];
    collectIndicatorLabels(getEntryExpression(strategy), labels);
    collectIndicatorLabels(getExitExpression(strategy), labels);
    return labels;
}

function getStrategyWarmupBars(strategy) {
    const labels = collectStrategyIndicatorLabels(strategy);
    if (!labels.length) return 1;
    return Math.max(1, ...labels.map((label) => getIndicatorWarmup(label)));
}

// --- Validation ---

function makeValidationError(message) {
    const error = new Error(message);
    error.statusCode = 400;
    error.clientMessage = message;
    return error;
}

function validateExpressionNode(node, state = { depth: 0, counter: { count: 0 } }) {
    state.counter.count += 1;

    if (state.counter.count > MAX_EXPRESSION_NODES) {
        throw makeValidationError(
            `Strategy expression has too many nodes (max ${MAX_EXPRESSION_NODES})`,
        );
    }

    if (state.depth > MAX_EXPRESSION_DEPTH) {
        throw makeValidationError(
            `Strategy expression is nested too deeply (max depth ${MAX_EXPRESSION_DEPTH})`,
        );
    }

    if (!node || typeof node !== "object" || Array.isArray(node)) {
        throw makeValidationError("Invalid expression node");
    }

    if (node.type === "condition") {
        if (typeof node.indicator !== "string" || !node.indicator.trim()) {
            throw makeValidationError("Condition is missing an indicator");
        }

        if (!VALID_OPERATORS.includes(node.operator)) {
            throw makeValidationError(`Invalid condition operator: ${String(node.operator)}`);
        }

        const compareType = node.compareType || "value";
        if (compareType !== "value" && compareType !== "indicator") {
            throw makeValidationError(`Invalid compareType: ${String(node.compareType)}`);
        }

        if (node.value === undefined || node.value === null || node.value === "") {
            throw makeValidationError("Condition is missing a value");
        }

        return;
    }

    if (node.type === "group") {
        if (node.operator !== "AND" && node.operator !== "OR") {
            throw makeValidationError(`Invalid group operator: ${String(node.operator)}`);
        }

        if (!Array.isArray(node.children) || node.children.length === 0) {
            throw makeValidationError("Group must have at least one child");
        }

        node.children.forEach((child) =>
            validateExpressionNode(child, { depth: state.depth + 1, counter: state.counter }),
        );

        return;
    }

    throw makeValidationError(`Unknown expression node type: ${String(node.type)}`);
}

/** Throws (statusCode 400, clientMessage set) on any malformed tree; no-op
 *  on a valid one. `label` is folded into the message for caller context
 *  (e.g. "entry expression" vs "exit expression"). */
function validateExpressionTree(node, label = "expression") {
    try {
        validateExpressionNode(node);
    } catch (error) {
        error.clientMessage = `Invalid ${label}: ${error.clientMessage}`;
        throw error;
    }
}

module.exports = {
    VALID_OPERATORS,
    MAX_EXPRESSION_DEPTH,
    MAX_EXPRESSION_NODES,
    evaluateCondition,
    getIndicatorValue,
    getPreviousIndicatorValue,
    conditionsToExpression,
    getEntryExpression,
    getExitExpression,
    evaluateExpression,
    collectIndicatorLabels,
    collectStrategyIndicatorLabels,
    getStrategyWarmupBars,
    validateExpressionNode,
    validateExpressionTree,
};
