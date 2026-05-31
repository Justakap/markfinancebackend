const { SMA } = require("technicalindicators");
const { fetchChart, fetchQuote } = require("./yahooClient");
const { getLatestRsi, getLatestEma, round2 } = require("./indicators");
const { inferCurrency } = require("./currency");

const CHART_CONFIG = [
    { key: "daily", interval: "1d", periodDays: 400 },
    { key: "hourly", interval: "1h", periodDays: 85 },
    { key: "15m", interval: "15m", periodDays: 55 },
    { key: "5m", interval: "5m", periodDays: 28 },
    { key: "1m", interval: "1m", periodDays: 6 },
];

function rsiChangePercent(current, previous) {
    if (
        current === null ||
        current === undefined ||
        previous === null ||
        previous === undefined ||
        previous === 0
    ) {
        return null;
    }

    return round2(((current - previous) / previous) * 100);
}

async function fetchChartSafe(symbol, interval, periodDays) {
    try {
        return await fetchChart(symbol, interval, periodDays);
    } catch (error) {
        console.log(`Chart failed ${symbol} ${interval}:`, error.message);
        return { quotes: [] };
    }
}

function filterCloses(quotes) {
    return quotes
        .map((q) => q.close)
        .filter(
            (close) =>
                close !== null && close !== undefined && !Number.isNaN(close),
        );
}

function filterVolumes(quotes) {
    return quotes
        .map((q) => q.volume)
        .filter((volume) => volume !== null && volume !== undefined);
}

function calculateRsiData(closes) {
    return getLatestRsi(closes, 14);
}

function volumeChangeFromCandles(quotes) {
    const volumes = filterVolumes(quotes);

    if (volumes.length < 2) return null;

    const current = volumes[volumes.length - 1];
    const previous = volumes[volumes.length - 2];

    if (!previous) return null;

    return ((current - previous) / previous) * 100;
}

async function getQuoteSnapshot(symbol) {
    const quote = await fetchQuote(symbol);

    return {
        currency: inferCurrency(symbol, "", quote.currency),
        price: quote.regularMarketPrice ?? 0,
        change: quote.regularMarketChangePercent ?? 0,
        changeAmount: quote.regularMarketChange ?? 0,
        volume: quote.regularMarketVolume ?? 0,
        pe: quote.trailingPE ?? 0,
    };
}

async function getMarketData(symbol) {
    try {
        const quote = await fetchQuote(symbol);

        const charts = {};

        await Promise.all(
            CHART_CONFIG.map(async (config) => {
                charts[config.key] = await fetchChartSafe(
                    symbol,
                    config.interval,
                    config.periodDays,
                );
            }),
        );

        const dailyQuotes = charts.daily?.quotes || [];
        const dailyCloses = filterCloses(dailyQuotes);
        const volumeChange = volumeChangeFromCandles(dailyQuotes);

        const high52Pct = quote.fiftyTwoWeekHigh
            ? ((quote.regularMarketPrice - quote.fiftyTwoWeekHigh) /
                  quote.fiftyTwoWeekHigh) *
              100
            : null;

        const low52Pct = quote.fiftyTwoWeekLow
            ? ((quote.regularMarketPrice - quote.fiftyTwoWeekLow) /
                  quote.fiftyTwoWeekLow) *
              100
            : null;

        let ema20 = null;
        let prevEma20 = null;

        if (dailyCloses.length >= 20) {
            const emaResult = getLatestEma(dailyCloses, 20);
            ema20 = emaResult.ema;
            prevEma20 = emaResult.prev;
        }

        let ema50 = null;
        let prevEma50 = null;

        if (dailyCloses.length >= 50) {
            const emaResult = getLatestEma(dailyCloses, 50);
            ema50 = emaResult.ema;
            prevEma50 = emaResult.prev;
        }

        let ema200 = null;
        let prevEma200 = null;

        if (dailyCloses.length >= 200) {
            const emaResult = getLatestEma(dailyCloses, 200);
            ema200 = emaResult.ema;
            prevEma200 = emaResult.prev;
        }

        let sma20 = null;
        let prevSma20 = null;

        if (dailyCloses.length >= 20) {
            const sma20Values = SMA.calculate({
                period: 20,
                values: dailyCloses,
            });
            sma20 = sma20Values[sma20Values.length - 1];
            prevSma20 =
                sma20Values.length >= 2
                    ? sma20Values[sma20Values.length - 2]
                    : null;
        }

        let sma50 = null;
        let prevSma50 = null;

        if (dailyCloses.length >= 50) {
            const sma50Values = SMA.calculate({
                period: 50,
                values: dailyCloses,
            });
            sma50 = sma50Values[sma50Values.length - 1];
            prevSma50 =
                sma50Values.length >= 2
                    ? sma50Values[sma50Values.length - 2]
                    : null;
        }

        const dailyRsi = calculateRsiData(dailyCloses);
        const hourlyRsiData = calculateRsiData(
            filterCloses(charts.hourly?.quotes || []),
        );
        const rsi15mData = calculateRsiData(
            filterCloses(charts["15m"]?.quotes || []),
        );
        const rsi5mData = calculateRsiData(
            filterCloses(charts["5m"]?.quotes || []),
        );
        const rsi1mData = calculateRsiData(
            filterCloses(charts["1m"]?.quotes || []),
        );

        const prevPrice =
            dailyCloses.length >= 2
                ? dailyCloses[dailyCloses.length - 2]
                : null;

        return {
            symbol,
            currency: inferCurrency(symbol, "", quote.currency),
            price: quote.regularMarketPrice ?? 0,
            change: quote.regularMarketChangePercent ?? 0,
            changeAmount: quote.regularMarketChange ?? 0,
            volume: quote.regularMarketVolume ?? 0,
            pe: quote.trailingPE ?? 0,
            ema20: round2(ema20),
            ema50: round2(ema50),
            ema200: round2(ema200),
            prevEma20: round2(prevEma20),
            prevEma50: round2(prevEma50),
            prevEma200: round2(prevEma200),
            sma20: round2(sma20),
            sma50: round2(sma50),
            prevSma20: round2(prevSma20),
            prevSma50: round2(prevSma50),
            volumeChange: round2(volumeChange),
            high52Pct: round2(high52Pct),
            low52Pct: round2(low52Pct),
            rsi: round2(dailyRsi.rsi),
            prevRsi: round2(dailyRsi.prev),
            rsiChange: rsiChangePercent(dailyRsi.rsi, dailyRsi.prev),
            hourlyRsi: round2(hourlyRsiData.rsi),
            prevHourlyRsi: round2(hourlyRsiData.prev),
            hourlyRsiChange: rsiChangePercent(
                hourlyRsiData.rsi,
                hourlyRsiData.prev,
            ),
            rsi15m: round2(rsi15mData.rsi),
            prevRsi15m: round2(rsi15mData.prev),
            rsi15mChange: rsiChangePercent(rsi15mData.rsi, rsi15mData.prev),
            rsi5m: round2(rsi5mData.rsi),
            prevRsi5m: round2(rsi5mData.prev),
            rsi5mChange: rsiChangePercent(rsi5mData.rsi, rsi5mData.prev),
            rsi1m: round2(rsi1mData.rsi),
            prevRsi1m: round2(rsi1mData.prev),
            rsi1mChange: rsiChangePercent(rsi1mData.rsi, rsi1mData.prev),
            prevPrice: round2(prevPrice),
        };
    } catch (error) {
        console.log("Yahoo Error:", symbol);
        console.log(error);

        return {
            symbol,
            currency: inferCurrency(symbol),
            price: 0,
            change: 0,
            changeAmount: 0,
            volume: 0,
            pe: 0,
            ema20: null,
            ema50: null,
            ema200: null,
            sma20: null,
            sma50: null,
            volumeChange: null,
            high52Pct: null,
            low52Pct: null,
            rsi: null,
            prevRsi: null,
            hourlyRsi: null,
            prevHourlyRsi: null,
            rsi15m: null,
            prevRsi15m: null,
            rsi5m: null,
            prevRsi5m: null,
            rsi1m: null,
            prevRsi1m: null,
            prevPrice: null,
        };
    }
}

module.exports = {
    getMarketData,
    getQuoteSnapshot,
    calculateRsiData,
    filterCloses,
    volumeChangeFromCandles,
};
