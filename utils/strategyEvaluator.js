const { RSI, EMA, SMA } = require("technicalindicators");

function getIndicatorValue(stock, indicator) {
    const map = {
        Price: stock.price,
        "Price Change %": stock.change,

        RSI14: stock.rsi,
        "RSI Change": stock.rsiChange,

        "Hourly RSI": stock.hourlyRsi,
        "Hourly RSI Change": stock.hourlyRsiChange,

        "15 Min RSI": stock.rsi15m,
        "15 Min RSI Change": stock.rsi15mChange,

        "5 Min RSI": stock.rsi5m,
        "5 Min RSI Change": stock.rsi5mChange,

        "1 Min RSI": stock.rsi1m,
        "1 Min RSI Change": stock.rsi1mChange,

        EMA20: stock.ema20,
        EMA50: stock.ema50,
        EMA200: stock.ema200,

        SMA20: stock.sma20,
        SMA50: stock.sma50,

        Volume: stock.volume,
        "Volume Change %": stock.volumeChange,

        "PE Ratio": stock.pe,

        "52 Week High %": stock.high52Pct,
        "52 Week Low %": stock.low52Pct,
    };

    return map[indicator];
}

function getPreviousIndicatorValue(stock, indicator) {
    // attempt to read a previous value from the provided current object
    const map = {
        Price: stock.prevPrice ?? null,
        "Price Change %": null,

        RSI14: stock.prevRsi ?? null,
        "RSI Change": null,

        "Hourly RSI": stock.prevHourlyRsi ?? null,
        "Hourly RSI Change": null,

        "15 Min RSI": stock.prevRsi15m ?? null,
        "15 Min RSI Change": null,

        "5 Min RSI": stock.prevRsi5m ?? null,
        "5 Min RSI Change": null,

        "1 Min RSI": stock.prevRsi1m ?? null,
        "1 Min RSI Change": null,

        EMA20: stock.prevEma20 ?? null,
        EMA50: stock.prevEma50 ?? null,
        EMA200: stock.prevEma200 ?? null,

        SMA20: stock.prevSma20 ?? null,
        SMA50: stock.prevSma50 ?? null,

        Volume: null,
        "Volume Change %": null,

        "PE Ratio": null,

        "52 Week High %": null,
        "52 Week Low %": null,
    };

    return map[indicator];
}

function evaluateCondition(current, previous, condition) {
    const left = getIndicatorValue(current, condition.indicator);

    let prevLeft = null;

    if (previous) prevLeft = getIndicatorValue(previous, condition.indicator);
    else prevLeft = getPreviousIndicatorValue(current, condition.indicator);

    let right;
    let prevRight = null;

    if (condition.compareType === "indicator") {
        right = getIndicatorValue(current, condition.value);

        if (previous) prevRight = getIndicatorValue(previous, condition.value);
        else prevRight = getPreviousIndicatorValue(current, condition.value);
    } else {
        right = Number(condition.value);
        prevRight = right;
    }

    if (left == null || right == null) return false;

    switch (condition.operator) {
        case ">":
            return left > right;
        case "<":
            return left < right;
        case ">=":
            return left >= right;
        case "<=":
            return left <= right;
        case "=":
            return left === right;
        case "Crosses Above":
            // need previous values for both sides
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

    for (let i = 1; i < conditions.length; i++) {
        const connector = conditions[i - 1].nextLogic || logic || "AND";
        const currentResult = evaluateCondition(current, previous, conditions[i]);

        if (connector === "OR") {
            result = result || currentResult;
        } else {
            result = result && currentResult;
        }
    }

    return result;
}

function getIndicatorWarmup(indicator) {
    switch (indicator) {
        case "RSI14":
            return 14;
        case "RSI Change":
            return 15;
        case "EMA20":
        case "SMA20":
            return 19;
        case "EMA50":
        case "SMA50":
            return 49;
        case "EMA200":
            return 199;
        default:
            return 1;
    }
}

function getBacktestStartIndex(entryConditions, exitConditions) {
    const indicators = [...(entryConditions || []), ...(exitConditions || [])].flatMap((condition) => {
        const values = [condition.indicator];
        if (condition.compareType === "indicator") values.push(condition.value);
        return values;
    });

    return Math.max(1, ...indicators.map(getIndicatorWarmup));
}

module.exports = {
    getIndicatorValue,
    getPreviousIndicatorValue,
    evaluateCondition,
    evaluateStrategy,
    getIndicatorWarmup,
    getBacktestStartIndex,
};
