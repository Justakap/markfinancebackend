const {
    getFieldForIndicator,
    getPrevFieldForIndicator,
    getIndicatorWarmup,
    normalizeIndicatorLabel,
} = require("./indicatorCatalog");

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

function evaluateStrategy(current, previous, conditions = [], logic = "AND") {
    if (!conditions || !conditions.length) return false;

    let result = evaluateCondition(current, previous, conditions[0]);

    for (let i = 1; i < conditions.length; i += 1) {
        const connector = conditions[i - 1].nextLogic || logic || "AND";
        const currentResult = evaluateCondition(
            current,
            previous,
            conditions[i],
        );

        if (connector === "OR") {
            result = result || currentResult;
        } else {
            result = result && currentResult;
        }
    }

    return result;
}

function getBacktestStartIndex(entryConditions, exitConditions) {
    const indicators = [
        ...(entryConditions || []),
        ...(exitConditions || []),
    ].flatMap((condition) => {
        const values = [condition.indicator];
        if (condition.compareType === "indicator") values.push(condition.value);
        return values;
    });

    return Math.max(
        1,
        ...indicators.map((label) => getIndicatorWarmup(label)),
    );
}

module.exports = {
    getIndicatorValue,
    getPreviousIndicatorValue,
    evaluateCondition,
    evaluateStrategy,
    getIndicatorWarmup,
    getBacktestStartIndex,
};
