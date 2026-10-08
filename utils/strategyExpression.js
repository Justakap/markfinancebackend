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
const {
    isRegisteredIndicator,
    indicatorKey,
    getIndicatorWarmupBars,
    VALID_TIMEFRAMES,
    PRICE_FIELDS,
} = require("./indicatorRegistry");

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

/**
 * ============================================================
 * Phase B — professional DSL (ADR-007: evolves this file, does not
 * replace it). Used only by StrategyVersion.definition documents (the new
 * system); completely independent of the legacy evaluateExpression()
 * above, which keeps serving Strategy.js's flat-condition strategies
 * unchanged.
 *
 * CONDITION leaf shape (new, structured — not the legacy
 * {indicator,operator,compareType,value} string-label shape):
 *
 *   { type: "condition", left: <operand>, operator: PROFESSIONAL_OPERATOR, right: <operand> }
 *
 * Operand shapes:
 *   { type: "indicator", name: "RSI", params: { period: 14 }, timeframe?: "5m" }
 *   { type: "price", field: "close" | "open" | "high" | "low" | "volume" }
 *   { type: "constant", value: <number> }
 *
 * GROUP shape is identical to the legacy one: { type: "group", operator: "AND"|"OR", children: [...] }.
 *
 * Context row shape Phase C's Indicator Engine must produce, and this
 * evaluator consumes (per timeframe, one row per evaluated bar):
 *
 *   { open, high, low, close, volume, indicators: { [indicatorKey(name,params)]: value|null } }
 *
 * A full StrategyContext is `{ [timeframe]: row }` so a condition whose
 * operand specifies a non-primary `timeframe` can still be resolved —
 * Phase C is responsible for aligning auxiliary-timeframe rows onto the
 * primary bar index (same problem backtestEngine.js's
 * alignRsiToPrimaryBars already solves for the legacy engine; Phase C
 * should generalize that, not reinvent it).
 * ============================================================
 */

const PROFESSIONAL_OPERATORS = ["GT", "LT", "GTE", "LTE", "EQ", "CROSSES_ABOVE", "CROSSES_BELOW"];

/** Picks the row for an operand's timeframe out of a multi-timeframe
 *  context; `defaultTimeframe` is the primary timeframe used when the
 *  operand doesn't specify its own. */
function pickContextRow(context, timeframe, defaultTimeframe) {
    if (!context) return null;
    const key = timeframe || defaultTimeframe;
    return context[key] || null;
}

function resolveOperand(row, operand) {
    if (!row || !operand) return null;

    if (operand.type === "constant") {
        const num = Number(operand.value);
        return Number.isFinite(num) ? num : null;
    }

    if (operand.type === "price") {
        const value = row[operand.field];
        return value === undefined || value === null ? null : value;
    }

    if (operand.type === "indicator") {
        const key = indicatorKey(operand.name, operand.params || {});
        const value = row.indicators?.[key];
        return value === undefined ? null : value;
    }

    return null;
}

function compareProfessional(operator, left, right, prevLeft, prevRight) {
    if (left == null || right == null) return false;

    switch (operator) {
        case "GT":
            return left > right;
        case "LT":
            return left < right;
        case "GTE":
            return left >= right;
        case "LTE":
            return left <= right;
        case "EQ":
            return left === right;
        case "CROSSES_ABOVE":
            if (prevLeft == null || prevRight == null) return false;
            return prevLeft <= prevRight && left > right;
        case "CROSSES_BELOW":
            if (prevLeft == null || prevRight == null) return false;
            return prevLeft >= prevRight && left < right;
        default:
            return false;
    }
}

/**
 * `current`/`previous` are StrategyContext objects (`{ [timeframe]: row }`
 * — see the file-level doc comment above). `defaultTimeframe` resolves any
 * operand that doesn't specify its own `timeframe`.
 */
function evaluateProfessionalCondition(current, previous, node, defaultTimeframe) {
    const leftRow = pickContextRow(current, node.left?.timeframe, defaultTimeframe);
    const rightRow = pickContextRow(current, node.right?.timeframe, defaultTimeframe);
    const left = resolveOperand(leftRow, node.left);
    const right = resolveOperand(rightRow, node.right);

    let prevLeft = null;
    let prevRight = null;
    if (previous) {
        prevLeft = resolveOperand(pickContextRow(previous, node.left?.timeframe, defaultTimeframe), node.left);
        prevRight = resolveOperand(pickContextRow(previous, node.right?.timeframe, defaultTimeframe), node.right);
    }

    return compareProfessional(node.operator, left, right, prevLeft, prevRight);
}

function evaluateProfessionalExpression(current, previous, node, defaultTimeframe) {
    if (!node) return false;

    if (node.type === "condition") {
        return evaluateProfessionalCondition(current, previous, node, defaultTimeframe);
    }

    if (node.type === "group") {
        const children = node.children || [];
        if (node.operator === "OR") {
            return children.some((child) => evaluateProfessionalExpression(current, previous, child, defaultTimeframe));
        }
        return children.every((child) => evaluateProfessionalExpression(current, previous, child, defaultTimeframe));
    }

    return false;
}

/** Recursively collects every (name, params, timeframe) an expression
 *  references — Phase C's context builder needs this to know what series
 *  to compute, per timeframe, before evaluation can run. Mirrors
 *  collectIndicatorLabels()'s role for the legacy DSL, but operand-aware. */
function collectIndicatorRequirements(node, acc = [], defaultTimeframe = null) {
    if (!node) return acc;

    if (node.type === "condition") {
        [node.left, node.right].forEach((operand) => {
            if (operand?.type === "indicator") {
                acc.push({
                    name: operand.name,
                    params: operand.params || {},
                    timeframe: operand.timeframe || defaultTimeframe,
                });
            }
        });
        return acc;
    }

    if (node.type === "group") {
        (node.children || []).forEach((child) => collectIndicatorRequirements(child, acc, defaultTimeframe));
    }

    return acc;
}

function getProfessionalWarmupBars(node, defaultTimeframe = null) {
    const requirements = collectIndicatorRequirements(node, [], defaultTimeframe);
    if (!requirements.length) return 1;
    return Math.max(1, ...requirements.map((req) => getIndicatorWarmupBars(req.name, req.params)));
}

function validateOperand(operand, path) {
    if (!operand || typeof operand !== "object" || Array.isArray(operand)) {
        throw makeValidationError(`${path}: invalid operand`);
    }

    if (operand.type === "constant") {
        if (!Number.isFinite(Number(operand.value))) {
            throw makeValidationError(`${path}: constant operand requires a numeric value`);
        }
        return;
    }

    if (operand.type === "price") {
        if (!PRICE_FIELDS.includes(operand.field)) {
            throw makeValidationError(`${path}: invalid price field "${String(operand.field)}"`);
        }
        return;
    }

    if (operand.type === "indicator") {
        if (!isRegisteredIndicator(operand.name)) {
            throw makeValidationError(
                `${path}: indicator "${String(operand.name)}" is not implemented yet — it cannot be used in a strategy until its series calculation exists (see BLOCKERS.md)`,
            );
        }
        if (operand.timeframe !== undefined && !VALID_TIMEFRAMES.includes(operand.timeframe)) {
            throw makeValidationError(`${path}: invalid timeframe "${String(operand.timeframe)}"`);
        }
        return;
    }

    throw makeValidationError(`${path}: unknown operand type "${String(operand.type)}"`);
}

function validateProfessionalNode(node, state = { depth: 0, counter: { count: 0 } }) {
    state.counter.count += 1;

    if (state.counter.count > MAX_EXPRESSION_NODES) {
        throw makeValidationError(`Strategy expression has too many nodes (max ${MAX_EXPRESSION_NODES})`);
    }

    if (state.depth > MAX_EXPRESSION_DEPTH) {
        throw makeValidationError(`Strategy expression is nested too deeply (max depth ${MAX_EXPRESSION_DEPTH})`);
    }

    if (!node || typeof node !== "object" || Array.isArray(node)) {
        throw makeValidationError("Invalid expression node");
    }

    if (node.type === "condition") {
        if (!PROFESSIONAL_OPERATORS.includes(node.operator)) {
            throw makeValidationError(`Invalid condition operator: ${String(node.operator)}`);
        }
        validateOperand(node.left, "left");
        validateOperand(node.right, "right");
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
            validateProfessionalNode(child, { depth: state.depth + 1, counter: state.counter }),
        );
        return;
    }

    throw makeValidationError(`Unknown expression node type: ${String(node.type)}`);
}

function validateProfessionalExpression(node, label = "expression") {
    try {
        validateProfessionalNode(node);
    } catch (error) {
        error.clientMessage = `Invalid ${label}: ${error.clientMessage}`;
        throw error;
    }
}

/**
 * Validates an entire StrategyVersion.definition document (not just one
 * entry/exit tree) — universe/risk/execution shape, per the professional
 * DSL example in the architecture audit. Deliberately conservative: only
 * validates what Phase B/D actually need to agree on; does not invent
 * fields no later phase consumes yet.
 */
function validateStrategyDefinition(definition) {
    if (!definition || typeof definition !== "object") {
        throw makeValidationError("Strategy definition must be an object");
    }

    if (definition.version !== 2) {
        throw makeValidationError('Strategy definition must declare "version": 2');
    }

    if (!definition.universe || !VALID_TIMEFRAMES.includes(definition.universe.timeframe)) {
        throw makeValidationError("universe.timeframe must be one of " + VALID_TIMEFRAMES.join(", "));
    }

    if (!definition.entry) {
        throw makeValidationError("A strategy definition requires an entry expression");
    }
    validateProfessionalExpression(definition.entry, "entry expression");

    if (definition.exit) {
        validateProfessionalExpression(definition.exit, "exit expression");
    }

    if (definition.risk) {
        ["stopLoss", "takeProfit"].forEach((key) => {
            const rule = definition.risk[key];
            if (rule === undefined) return;
            if (rule.type !== "percent" || !Number.isFinite(Number(rule.value)) || Number(rule.value) <= 0) {
                throw makeValidationError(`risk.${key} must be {type:"percent", value:<positive number>}`);
            }
        });
    }

    if (definition.execution) {
        if (definition.execution.side && definition.execution.side !== "LONG") {
            // Short positions are an explicitly deferred phase (architecture
            // audit §9/Risk-Execution model) — reject rather than silently
            // accept and ignore.
            throw makeValidationError('execution.side: only "LONG" is supported in this phase');
        }
        const sizing = definition.execution.positionSizing;
        if (sizing) {
            const validSizingTypes = ["percentOfEquity", "fixedQuantity", "fixedCash", "riskPercent"];
            if (!validSizingTypes.includes(sizing.type)) {
                throw makeValidationError(`execution.positionSizing.type must be one of ${validSizingTypes.join(", ")}`);
            }
            if (!Number.isFinite(Number(sizing.value)) || Number(sizing.value) <= 0) {
                throw makeValidationError("execution.positionSizing.value must be a positive number");
            }
            // Phase E: riskPercent sizing computes quantity from the stop
            // distance — meaningless (and silently zero at runtime) without
            // a configured stop-loss to measure that distance from.
            if (sizing.type === "riskPercent" && !definition.risk?.stopLoss) {
                throw makeValidationError("execution.positionSizing.type \"riskPercent\" requires risk.stopLoss to be set");
            }
        }

        // Phase E: optional per-strategy cost assumptions. Deliberately NOT
        // read by the execution engine itself (backtestExecutionEngine.js
        // takes commissionPct/slippagePct as explicit call parameters) —
        // this is reproducibility metadata a future route/UI can surface
        // as the strategy's own defaults, keeping the engine decoupled
        // from where cost config comes from.
        if (definition.execution.costs) {
            ["commissionPct", "slippagePct"].forEach((key) => {
                const value = definition.execution.costs[key];
                if (value === undefined) return;
                if (!Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 5) {
                    throw makeValidationError(`execution.costs.${key} must be a number between 0 and 5 (percent)`);
                }
            });
        }
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

    // Phase B — professional DSL (separate from everything above)
    PROFESSIONAL_OPERATORS,
    resolveOperand,
    evaluateProfessionalCondition,
    evaluateProfessionalExpression,
    collectIndicatorRequirements,
    getProfessionalWarmupBars,
    validateProfessionalNode,
    validateProfessionalExpression,
    validateStrategyDefinition,
};
