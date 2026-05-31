const marketCache = require("./marketCache");
const {
    getMarketData,
    getQuoteSnapshot,
} = require("../utils/marketDataService");
const { mapWithLimit } = require("../utils/concurrency");
const {
    getRefreshIntervalsForSymbol,
    getCombinedMarketStatus,
    inferMarketType,
} = require("../utils/marketStatus");
const { dedupe } = require("../utils/requestDedup");
const {
    recordEngineRefresh,
    recordMarketDataTime,
    recordSocketUpdate,
} = require("../utils/metrics");

let io = null;
let priceTimer = null;
let indicatorTimer = null;
let cryptoTimer = null;
const trackedSymbols = new Set();
const symbolRegistry = new Map();
const watchlistSymbols = new Map();

function registerSymbol(yahooSymbol, meta = {}) {
    if (!yahooSymbol) return;
    trackedSymbols.add(yahooSymbol);
    symbolRegistry.set(yahooSymbol, {
        market: meta.market || "",
        displaySymbol: meta.displaySymbol || meta.symbol || yahooSymbol,
        name: meta.name || "",
        marketType: inferMarketType(
            meta.displaySymbol || meta.symbol || yahooSymbol,
            meta.market,
        ),
    });
}

function init(socketIo) {
    io = socketIo;
    startLoops();
}

function trackSymbols(symbols = []) {
    symbols.forEach((entry) => {
        if (typeof entry === "string") {
            registerSymbol(entry);
            return;
        }

        registerSymbol(entry.yahooSymbol || entry.symbol, entry);
    });
}

function trackWatchlist(watchlistId, stocks = []) {
    watchlistSymbols.set(
        watchlistId,
        stocks.map((s) => s.yahooSymbol || s.symbol),
    );
    trackSymbols(stocks);
}

function untrackWatchlist(watchlistId) {
    watchlistSymbols.delete(watchlistId);
}

function getSymbolMeta(yahooSymbol) {
    return symbolRegistry.get(yahooSymbol) || { market: "", marketType: "nse" };
}

function broadcastDelta(delta, yahooSymbol) {
    if (!delta || !io) return;

    const meta = getSymbolMeta(yahooSymbol);
    const payload = {
        ...delta,
        symbol: meta.displaySymbol || delta.symbol,
    };

    recordSocketUpdate();
    io.emit("stockUpdate", payload);
}

function isCryptoSymbol(yahooSymbol) {
    const info = getSymbolMeta(yahooSymbol);
    return (
        info.marketType === "crypto" ||
        inferMarketType(info.displaySymbol || yahooSymbol, info.market) ===
            "crypto"
    );
}

async function refreshPrice(yahooSymbol) {
    const cacheKey = `price:${yahooSymbol}`;

    return dedupe(cacheKey, async () => {
        const start = Date.now();
        const partial = await getQuoteSnapshot(yahooSymbol);
        const now = Date.now();
        const delta = marketCache.merge(yahooSymbol, partial, {
            priceUpdatedAt: now,
        });

        recordMarketDataTime(Date.now() - start);

        if (delta) {
            broadcastDelta(delta, yahooSymbol);
        } else if (isCryptoSymbol(yahooSymbol)) {
            const cached = marketCache.get(yahooSymbol) || partial;
            broadcastDelta({ ...cached, updatedAt: now }, yahooSymbol);
        }

        return partial;
    });
}

async function refreshIndicators(yahooSymbol) {
    const cacheKey = `indicators:${yahooSymbol}`;

    return dedupe(cacheKey, async () => {
        const start = Date.now();
        recordEngineRefresh();

        const data = await getMarketData(yahooSymbol);
        const now = Date.now();
        const delta = marketCache.set(yahooSymbol, data, {
            rsiUpdatedAt: now,
            emaUpdatedAt: now,
            peUpdatedAt: now,
        });

        recordMarketDataTime(Date.now() - start);
        broadcastDelta(delta, yahooSymbol);
        return data;
    });
}

async function refreshSymbol(yahooSymbol) {
    const cacheKey = `engine:${yahooSymbol}`;

    return dedupe(cacheKey, async () => {
        const start = Date.now();
        recordEngineRefresh();

        const data = await getMarketData(yahooSymbol);
        const now = Date.now();
        const delta = marketCache.set(yahooSymbol, data, {
            priceUpdatedAt: now,
            rsiUpdatedAt: now,
            emaUpdatedAt: now,
            peUpdatedAt: now,
        });

        recordMarketDataTime(Date.now() - start);
        broadcastDelta(delta, yahooSymbol);
        return data;
    });
}

function isPriceStale(yahooSymbol, now = Date.now()) {
    const meta = marketCache.getMeta(yahooSymbol);
    const info = getSymbolMeta(yahooSymbol);
    const intervals = getRefreshIntervalsForSymbol(
        info.displaySymbol || yahooSymbol,
        info.market,
    );

    if (!meta) return true;
    return now - (meta.priceUpdatedAt || 0) >= intervals.priceMs;
}

function isIndicatorStale(yahooSymbol, now = Date.now()) {
    const meta = marketCache.getMeta(yahooSymbol);
    const info = getSymbolMeta(yahooSymbol);
    const intervals = getRefreshIntervalsForSymbol(
        info.displaySymbol || yahooSymbol,
        info.market,
    );

    if (!meta) return true;

    const rsiAge = now - (meta.rsiUpdatedAt || 0);
    const emaAge = now - (meta.emaUpdatedAt || 0);
    const peAge = now - (meta.peUpdatedAt || 0);

    return (
        rsiAge >= intervals.rsiMs ||
        emaAge >= intervals.emaMs ||
        peAge >= intervals.peMs
    );
}

function needsIndicatorWarm(yahooSymbol) {
    const meta = marketCache.getMeta(yahooSymbol);
    if (!meta) return true;
    const cached = marketCache.get(yahooSymbol);
    return cached?.rsi == null && cached?.ema20 == null;
}

async function refreshPriceBatch(limit = 6) {
    const symbols = [...trackedSymbols];
    if (!symbols.length) return;

    const now = Date.now();
    const stale = symbols.filter((symbol) => isPriceStale(symbol, now));

    if (!stale.length) return;

    await mapWithLimit(stale.slice(0, 30), limit, (symbol) =>
        refreshPrice(symbol),
    );
}

async function refreshIndicatorBatch(limit = 4) {
    const symbols = [...trackedSymbols];
    if (!symbols.length) return;

    const now = Date.now();
    const stale = symbols.filter((symbol) => isIndicatorStale(symbol, now));

    if (!stale.length) return;

    await mapWithLimit(stale.slice(0, 20), limit, (symbol) =>
        refreshIndicators(symbol),
    );
}

async function refreshCryptoBatch(limit = 4) {
    const cryptoSymbols = [...trackedSymbols].filter((sym) =>
        isCryptoSymbol(sym),
    );

    if (!cryptoSymbols.length) return;

    const now = Date.now();
    const stale = cryptoSymbols.filter((sym) => {
        const meta = marketCache.getMeta(sym);
        if (!meta) return true;
        return now - (meta.priceUpdatedAt || 0) >= 8_000;
    });

    if (!stale.length) return;

    await mapWithLimit(stale.slice(0, 10), limit, (symbol) =>
        refreshPrice(symbol),
    );
}

function startLoops() {
    if (priceTimer) clearInterval(priceTimer);
    if (indicatorTimer) clearInterval(indicatorTimer);
    if (cryptoTimer) clearInterval(cryptoTimer);

    priceTimer = setInterval(() => {
        refreshPriceBatch(6).catch((err) =>
            console.log("Market engine price refresh:", err.message),
        );
    }, 10_000);

    cryptoTimer = setInterval(() => {
        refreshCryptoBatch(4).catch((err) =>
            console.log("Market engine crypto refresh:", err.message),
        );
    }, 5_000);

    indicatorTimer = setInterval(() => {
        refreshIndicatorBatch(4).catch((err) =>
            console.log("Market engine indicator refresh:", err.message),
        );
    }, 60_000);
}

function getCachedBatch(stocks = []) {
    return stocks.map((stock) => {
        const yahooSymbol = stock.yahooSymbol || stock.symbol;
        const cached = marketCache.get(yahooSymbol);

        if (cached) {
            return {
                ...cached,
                symbol: stock.symbol,
                displayName: stock.name || cached.displayName,
            };
        }

        return null;
    });
}

function getWatchlistFromCache(stocks = [], { offset = 0, limit = 50 } = {}) {
    const slice = stocks.slice(offset, offset + limit);
    const cached = getCachedBatch(slice);
    const hits = cached.filter(Boolean);

    return {
        data: hits,
        total: stocks.length,
        offset,
        limit,
        cachedCount: hits.length,
        missing: slice.length - hits.length,
        marketStatus: getCombinedMarketStatus(),
        updatedAt: hits.length
            ? Math.max(...hits.map((r) => r.updatedAt || 0))
            : null,
    };
}

async function warmQuotesFast(stocks = [], concurrency = 6) {
    const missing = stocks.filter((stock) => {
        const sym = stock.yahooSymbol || stock.symbol;
        return !marketCache.has(sym);
    });

    if (!missing.length) return [];

    return mapWithLimit(missing, concurrency, async (stock) => {
        const sym = stock.yahooSymbol || stock.symbol;
        registerSymbol(sym, stock);

        const quote = await getQuoteSnapshot(sym);
        const now = Date.now();
        const delta = marketCache.merge(sym, quote, {
            priceUpdatedAt: now,
        });

        broadcastDelta(delta, sym);

        return {
            ...quote,
            symbol: stock.displaySymbol || stock.symbol,
            displayName: stock.name,
        };
    });
}

async function warmIndicators(stocks = [], concurrency = 3) {
    const targets = stocks.filter((stock) => {
        const sym = stock.yahooSymbol || stock.symbol;
        return needsIndicatorWarm(sym);
    });

    if (!targets.length) return [];

    return mapWithLimit(targets, concurrency, async (stock) => {
        const sym = stock.yahooSymbol || stock.symbol;
        registerSymbol(sym, stock);
        const data = await refreshIndicators(sym);
        return {
            ...data,
            symbol: stock.displaySymbol || stock.symbol,
            displayName: stock.name,
        };
    });
}

async function warmMissing(stocks = [], concurrency = 4) {
    await warmQuotesFast(stocks, concurrency);
    warmIndicators(stocks, concurrency).catch((err) =>
        console.log("Indicator warm:", err.message),
    );
    return getCachedBatch(stocks).filter(Boolean);
}

function getScanData(stocks = []) {
    const start = Date.now();
    const rows = getCachedBatch(
        stocks.map((s) => ({
            symbol: s.symbol,
            yahooSymbol: s.yahooSymbol || s.symbol,
            name: s.name,
        })),
    ).filter(Boolean);

    return {
        rows,
        durationMs: Date.now() - start,
        cacheOnly: true,
    };
}

module.exports = {
    init,
    trackSymbols,
    trackWatchlist,
    untrackWatchlist,
    refreshSymbol,
    refreshPrice,
    refreshIndicators,
    refreshPriceBatch,
    refreshIndicatorBatch,
    getCachedBatch,
    getWatchlistFromCache,
    warmQuotesFast,
    warmIndicators,
    warmMissing,
    getScanData,
    getMarketStatus: getCombinedMarketStatus,
};
