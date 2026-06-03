const { evaluateStrategy } = require("../utils/strategyEvaluator");
const {
    buildBacktestIndicators,
    fetchCandleSeriesForBacktest,
    resolveBacktestConfig,
    dataRowToEvaluatorSnapshot,
} = require("../utils/backtestEngine");
const {
    getCachedPe,
    getPeForInstrument,
} = require("./fundamentalService");
const { resolveStockInstrumentKey } = require("../utils/instrumentKeyResolver");
const upstoxMarketData = require("./marketDataService");

function resolveDisplaySymbol(stock = {}, instrumentKey = "") {
    const meta = instrumentKey
        ? upstoxMarketData.getInstrumentMeta(instrumentKey)
        : null;

    const symbol =
        stock.symbol ||
        meta?.symbol ||
        stock.name ||
        meta?.name ||
        meta?.shortName ||
        "";

    if (symbol) {
        return String(symbol).replace(/\.(NS|BO)$/i, "");
    }

    if (instrumentKey && instrumentKey.includes("|")) {
        return instrumentKey.split("|")[1] || instrumentKey;
    }

    return instrumentKey || "—";
}

async function mapWithLimit(items = [], limit, worker) {
    if (!items.length) return [];
    const results = new Array(items.length);
    let cursor = 0;

    async function runner() {
        while (cursor < items.length) {
            const index = cursor++;
            results[index] = await worker(items[index], index);
        }
    }

    await Promise.all(
        Array.from({ length: Math.min(limit, items.length) }, () => runner()),
    );
    return results;
}

function getEntryConditions(strategy) {
    return strategy.entryConditions?.length
        ? strategy.entryConditions
        : strategy.conditions || [];
}

function getScanMode(strategy) {
    const exitConditions = strategy.exitConditions || [];
    const hasExitRules =
        exitConditions.length > 0 ||
        Number(strategy.stopLoss) > 0 ||
        Number(strategy.target) > 0;

    return hasExitRules ? "active" : "entry";
}

async function buildScanEvaluatorRows(stock, strategy) {
    const instrumentKey = stock.instrumentKey;
    if (!instrumentKey) return null;

    const config = resolveBacktestConfig(strategy, "3mo", {
        instrumentType: stock.instrumentType || stock.assetType || stock.type,
    });
    const candles = await fetchCandleSeriesForBacktest(
        instrumentKey,
        config.interval,
        config.effectiveDays,
    );

    if (candles.length < 2) return null;

    const auxiliaryCandles = {};

    for (const interval of config.requiredIntervals) {
        if (interval === config.interval) continue;
        auxiliaryCandles[interval] = await fetchCandleSeriesForBacktest(
            instrumentKey,
            interval,
            config.effectiveDays,
        );
    }

    let pe = getCachedPe(instrumentKey) ?? stock.trailingPE ?? null;
    if (pe == null) {
        try {
            pe = await getPeForInstrument(
                instrumentKey,
                stock.instrumentType || stock.assetType,
            );
        } catch {
            pe = null;
        }
    }

    const data = buildBacktestIndicators(
        candles,
        config.interval,
        auxiliaryCandles,
        { pe },
    );
    const lastIndex = data.length - 1;
    const currentRow = data[lastIndex];
    const previousRow = data[lastIndex - 1];

    const current = {
        ...dataRowToEvaluatorSnapshot(currentRow),
        prevPrice: previousRow?.close ?? currentRow.close,
    };
    const previous = dataRowToEvaluatorSnapshot(previousRow);

    const displaySymbol = resolveDisplaySymbol(stock, instrumentKey);
    const meta = upstoxMarketData.getInstrumentMeta(instrumentKey);

    return {
        current,
        previous,
        meta: {
            symbol: displaySymbol,
            name:
                stock.name ||
                stock.longName ||
                meta?.name ||
                displaySymbol,
            instrumentKey,
            exchange:
                stock.exchange || stock.market || meta?.exchange || "",
        },
    };
}

function matchesScan(strategy, current, previous) {
    const entryConditions = getEntryConditions(strategy);
    const exitConditions = strategy.exitConditions || [];
    const logic = strategy.logic || "AND";
    const mode = getScanMode(strategy);

    const entry = evaluateStrategy(
        current,
        previous,
        entryConditions,
        logic,
    );

    if (mode === "entry") {
        return entry;
    }

    if (!entry) return false;

    if (exitConditions.length) {
        const exit = evaluateStrategy(
            current,
            previous,
            exitConditions,
            logic,
        );
        if (exit) return false;
    }

    const refEntry = previous?.price ?? current.prevPrice;
    const price = current.price;
    const stopLossPct = Number(strategy.stopLoss) || 0;
    const targetPct = Number(strategy.target) || 0;

    if (
        stopLossPct > 0 &&
        refEntry &&
        price <= refEntry * (1 - stopLossPct / 100)
    ) {
        return false;
    }

    if (
        targetPct > 0 &&
        refEntry &&
        price >= refEntry * (1 + targetPct / 100)
    ) {
        return false;
    }

    return true;
}

async function prepareWatchlistStocks(stocks = []) {
    const skipped = [];
    const resolved = [];

    for (const stock of stocks) {
        const lookup = await resolveStockInstrumentKey(stock);

        if (!lookup?.instrumentKey) {
            skipped.push({
                symbol: stock.symbol,
                instrumentKey: stock.instrumentKey,
                reason:
                    "Invalid or expired Upstox instrument key — remove and re-add from search",
            });
            continue;
        }

        resolved.push({
            ...stock,
            symbol:
                stock.symbol ||
                lookup.meta?.symbol ||
                resolveDisplaySymbol(stock, lookup.instrumentKey),
            name:
                stock.name ||
                stock.longName ||
                lookup.meta?.name ||
                lookup.meta?.symbol,
            instrumentKey: lookup.instrumentKey,
            instrumentType:
                lookup.meta?.instrumentType ||
                stock.instrumentType ||
                stock.assetType,
            exchange: lookup.meta?.exchange || stock.exchange,
            repairedKey: lookup.repaired,
        });
    }

    return { resolved, skipped };
}

async function runStrategyScan(strategy, watchlist) {
    const stocks = watchlist.stocks || [];
    const scanMode = getScanMode(strategy);
    const scanStart = Date.now();
    const { resolved, skipped } = await prepareWatchlistStocks(stocks);

    const evaluated = await mapWithLimit(resolved, 3, async (stock) => {
        try {
            return await buildScanEvaluatorRows(stock, strategy);
        } catch (error) {
            console.log(
                `Scan row failed ${stock.symbol}:`,
                error.message,
            );
            return null;
        }
    });

    const matches = [];

    evaluated.filter(Boolean).forEach((row) => {
        if (!matchesScan(strategy, row.current, row.previous)) return;

        matches.push({
            symbol: row.meta.symbol,
            name: row.meta.name,
            instrumentKey: row.meta.instrumentKey,
            exchange: row.meta.exchange,
            price: row.current.price,
            change: row.current.change,
            volume: row.current.volume,
            ema20: row.current.ema20,
            ema50: row.current.ema50,
            ema200: row.current.ema200,
            rsi: row.current.rsi,
            pe: row.current.pe,
            scanMode,
            signalType:
                scanMode === "entry" ? "ENTRY_SIGNAL" : "ACTIVE_SETUP",
        });
    });

    return {
        scanMode,
        matches,
        skipped,
        scanTimeMs: Date.now() - scanStart,
        evaluated: resolved.length,
        dataSource: "upstox",
    };
}

module.exports = {
    runStrategyScan,
    getScanMode,
    matchesScan,
    prepareWatchlistStocks,
};
