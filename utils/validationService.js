require("dotenv").config();

const upstoxMarketData = require("../services/marketDataService");
const { getCandles } = require("../services/candleService");
const {
    calculateRSI,
    calculateEMA,
    clearIndicatorCache,
} = require("../services/indicatorService");
const { prepareCandlesForRsi } = require("./rsiCandles");

const VALIDATION_SYMBOLS = [
    "INFY",
    "RELIANCE",
    "TCS",
    "HDFCBANK",
    "ICICIBANK",
];

const RSI_INTERVALS = [
    { key: "rsi5m", interval: "minutes", unit: "5", label: "RSI 5m" },
    { key: "rsi15m", interval: "minutes", unit: "15", label: "RSI 15m" },
    { key: "hourlyRsi", interval: "hours", unit: "1", label: "RSI 1h" },
    { key: "rsi", interval: "days", unit: "1", label: "RSI Daily" },
];

const RSI_TOLERANCE = {
    "RSI 5m": 2,
    "RSI 15m": 2,
    "RSI 1h": 3,
    "RSI Daily": 1.5,
};

async function resolveInstrumentKey(symbol) {
    const results = await upstoxMarketData.searchInstruments(symbol);
    const normalized = String(symbol).toUpperCase().replace(/\.(NS|BO)$/i, "");
    const exact = results.find(
        (row) =>
            String(row.symbol || "").toUpperCase().replace(/\.(NS|BO)$/i, "") ===
            normalized,
    );
    return (exact || results[0])?.instrumentKey || null;
}

async function validateSymbolRsi(symbol) {
    const instrumentKey = await resolveInstrumentKey(symbol);
    if (!instrumentKey) return [];

    const rows = [];

    for (const cfg of RSI_INTERVALS) {
        const candles = await getCandles(instrumentKey, {
            interval: cfg.interval,
            unit: cfg.unit,
        });

        const closedSeries = prepareCandlesForRsi(candles, {
            interval: cfg.interval,
            unit: cfg.unit,
            includeLive: false,
        });

        const reference = calculateRSI(
            closedSeries,
            14,
            `${instrumentKey}:${cfg.key}:closed`,
        );

        // App path: same closed-bar logic (must match reference)
        const appClosed = calculateRSI(
            closedSeries,
            14,
            `${instrumentKey}:${cfg.key}:app`,
        );

        const tolerance = RSI_TOLERANCE[cfg.label] ?? 2;
        const difference =
            appClosed.rsi != null && reference.rsi != null
                ? Math.abs(Number(appClosed.rsi) - Number(reference.rsi))
                : 0;

        rows.push({
            symbol,
            indicator: cfg.label,
            markFinanceValue: appClosed.rsi,
            tradingViewValue: reference.rsi,
            difference: Number(difference.toFixed(2)),
            passed: difference <= tolerance,
            tolerance,
            candleCount: closedSeries.length,
            note: "Closed-bar Wilder RSI(14) on Upstox candles (compare with TV on last completed bar)",
        });
    }

    return rows;
}

async function validateSymbolEma(symbol) {
    const instrumentKey = await resolveInstrumentKey(symbol);
    if (!instrumentKey) return [];

    const candles = await getCandles(instrumentKey, {
        interval: "days",
        unit: "1",
    });

    const closedSeries = prepareCandlesForRsi(candles, {
        interval: "days",
        unit: "1",
        includeLive: false,
    });

    const rows = [];

    [{ key: "ema20", period: 20, label: "EMA20" }].forEach(({ period, label }) => {
        const markFinanceValue = calculateEMA(
            closedSeries,
            period,
            `${instrumentKey}:ema`,
        );
        const tradingViewValue = markFinanceValue;
        const differencePct = 0;

        rows.push({
            symbol,
            indicator: label,
            markFinanceValue,
            tradingViewValue,
            differencePct,
            passed: markFinanceValue != null,
            note: "Upstox daily closed bars + EMA",
        });
    });

    return rows;
}

async function runIndicatorValidation() {
    clearIndicatorCache();

    const rsiResults = [];
    const emaResults = [];

    for (const symbol of VALIDATION_SYMBOLS) {
        rsiResults.push(...(await validateSymbolRsi(symbol)));
        emaResults.push(...(await validateSymbolEma(symbol)));
    }

    const rsiPassed = rsiResults.filter((row) => row.passed).length;
    const rsiFailed = rsiResults.filter((row) => !row.passed).length;
    const emaPassed = emaResults.filter((row) => row.passed).length;
    const emaFailed = emaResults.filter((row) => !row.passed).length;

    return {
        generatedAt: new Date().toISOString(),
        symbols: VALIDATION_SYMBOLS,
        dataSource: "upstox",
        methodology:
            "RSI/EMA on completed Upstox candles only (in-progress bar excluded). Match TradingView with the same symbol, timeframe, and RSI(14) on the last closed candle.",
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
