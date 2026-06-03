/** Built-in strategies for backtest / scan demos (classic RSI mean-reversion). */

const SAMPLE_STRATEGIES = [
    {
        name: "[Sample] RSI Mean Reversion (Daily)",
        description:
            "Buy when daily RSI(14) crosses below 35, sell when it crosses above 65. Common mean-reversion template (similar to classic 30/70 RSI systems).",
        entryConditions: [
            {
                indicator: "RSI (Daily)",
                operator: "Crosses Below",
                compareType: "value",
                value: "35",
            },
        ],
        exitConditions: [
            {
                indicator: "RSI (Daily)",
                operator: "Crosses Above",
                compareType: "value",
                value: "65",
            },
        ],
        stopLoss: 8,
        target: 12,
        logic: "AND",
        alertEnabled: false,
        isSample: true,
    },
    {
        name: "[Sample] 5m RSI Swing",
        description:
            "5-minute RSI crosses — more trades within Upstox intraday history (~28 days max).",
        entryConditions: [
            {
                indicator: "RSI (5 Minute)",
                operator: "Crosses Below",
                compareType: "value",
                value: "40",
            },
        ],
        exitConditions: [
            {
                indicator: "RSI (5 Minute)",
                operator: "Crosses Above",
                compareType: "value",
                value: "60",
            },
        ],
        stopLoss: 5,
        target: 8,
        logic: "AND",
        alertEnabled: false,
        isSample: true,
    },
    {
        name: "[Sample] Trend + RSI Pullback",
        description:
            "Price above EMA20 with daily RSI pullback entry — trend-following with RSI filter.",
        entryConditions: [
            {
                indicator: "Price",
                operator: ">",
                compareType: "indicator",
                value: "EMA20",
                nextLogic: "AND",
            },
            {
                indicator: "RSI (Daily)",
                operator: "Crosses Below",
                compareType: "value",
                value: "45",
            },
        ],
        exitConditions: [
            {
                indicator: "RSI (Daily)",
                operator: "Crosses Above",
                compareType: "value",
                value: "58",
            },
        ],
        stopLoss: 6,
        target: 10,
        logic: "AND",
        alertEnabled: false,
        isSample: true,
    },
];

module.exports = {
    SAMPLE_STRATEGIES,
};
