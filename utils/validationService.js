require("dotenv").config();

const { RSI: LegacyRsi } = require("technicalindicators");
const { getMarketData, filterCloses } = require("../utils/marketDataService");
const { fetchChart } = require("../utils/yahooClient");
const {
    getLatestRsi,
    getLatestEma,
    round2,
    percentDiff,
} = require("../utils/indicators");

const VALIDATION_SYMBOLS = [
    "INFY.NS",
    "RELIANCE.NS",
    "TCS.NS",
    "HDFCBANK.NS",
    "ICICIBANK.NS",
    "NIACL.NS",
];

const RSI_INTERVALS = [
    { key: "rsi1m", label: "RSI 1m", interval: "1m", days: 7 },
    { key: "rsi5m", label: "RSI 5m", interval: "5m", days: 30 },
    { key: "rsi15m", label: "RSI 15m", interval: "15m", days: 55 },
    { key: "hourlyRsi", label: "RSI 1h", interval: "1h", days: 90 },
    { key: "rsi", label: "RSI Daily", interval: "1d", days: 400 },
];

function legacyRsiLast(closes) {
    if (closes.length < 15) return null;
    const values = LegacyRsi.calculate({ period: 14, values: closes });
    return values.length ? round2(values[values.length - 1]) : null;
}

async function validateSymbolRsi(symbol) {
    const market = await getMarketData(symbol);
    const rows = [];

    for (const cfg of RSI_INTERVALS) {
        const markFinanceValue = market[cfg.key];

        let chartCloses = [];

        try {
            const chart = await fetchChart(symbol, cfg.interval, cfg.days);
            chartCloses = filterCloses(chart.quotes || []);
        } catch {
            chartCloses = [];
        }

        const wilder = getLatestRsi(chartCloses, 14);
        const tradingViewValue = round2(wilder.rsi);
        const legacyValue = legacyRsiLast(chartCloses);
        const difference =
            markFinanceValue !== null && tradingViewValue !== null
                ? round2(Math.abs(markFinanceValue - tradingViewValue))
                : null;

        rows.push({
            symbol,
            indicator: cfg.label,
            markFinanceValue,
            tradingViewValue,
            legacyLibraryValue: legacyValue,
            difference,
            passed: difference !== null ? difference <= 1 : false,
            note: "TradingView reference uses Wilder's RSI (period 14)",
        });
    }

    return rows;
}

async function validateSymbolEma(symbol) {
    const market = await getMarketData(symbol);
    const chart = await fetchChart(symbol, "1d", 400);
    const closes = filterCloses(chart.quotes || []);
    const rows = [];

    [
        { key: "ema20", period: 20, label: "EMA20" },
        { key: "ema50", period: 50, label: "EMA50" },
        { key: "ema200", period: 200, label: "EMA200" },
    ].forEach(({ key, period, label }) => {
        const markFinanceValue = market[key];
        const reference = getLatestEma(closes, period);
        const tradingViewValue = round2(reference.ema);
        const differencePct = percentDiff(markFinanceValue, tradingViewValue);

        rows.push({
            symbol,
            indicator: label,
            markFinanceValue,
            tradingViewValue,
            differencePct,
            passed: differencePct !== null ? differencePct < 0.5 : false,
            note: "TradingView reference uses standard EMA formula",
        });
    });

    return rows;
}

async function runIndicatorValidation() {
    const rsiResults = [];
    const emaResults = [];

    for (const symbol of VALIDATION_SYMBOLS) {
        rsiResults.push(...(await validateSymbolRsi(symbol)));
        emaResults.push(...(await validateSymbolEma(symbol)));
    }

    const rsiPassed = rsiResults.filter((row) => row.passed).length;
    const rsiFailed = rsiResults.filter(
        (row) => row.difference !== null && !row.passed,
    ).length;
    const emaPassed = emaResults.filter((row) => row.passed).length;
    const emaFailed = emaResults.filter(
        (row) => row.differencePct !== null && !row.passed,
    ).length;

    return {
        generatedAt: new Date().toISOString(),
        symbols: VALIDATION_SYMBOLS,
        rsi: {
            results: rsiResults,
            passed: rsiPassed,
            failed: rsiFailed,
            total: rsiResults.length,
            allPassed: rsiFailed === 0,
        },
        ema: {
            results: emaResults,
            passed: emaPassed,
            failed: emaFailed,
            total: emaResults.length,
            allPassed: emaFailed === 0,
        },
    };
}

module.exports = {
    VALIDATION_SYMBOLS,
    runIndicatorValidation,
    validateSymbolRsi,
    validateSymbolEma,
};

if (require.main === module) {
    runIndicatorValidation()
        .then((report) => {
            console.log(JSON.stringify(report, null, 2));
            process.exit(report.rsi.allPassed && report.ema.allPassed ? 0 : 1);
        })
        .catch((error) => {
            console.error(error);
            process.exit(1);
        });
}
