const stats = {
    yahooRequests: 0,
    cacheHits: 0,
    cacheMisses: 0,
    scanTimes: [],
    marketDataTimes: [],
    backtestTimes: [],
    engineRefreshes: 0,
    socketUpdates: 0,
    startedAt: Date.now(),
};

function recordYahooRequest() {
    stats.yahooRequests += 1;
}

function recordCacheHit() {
    stats.cacheHits += 1;
}

function recordCacheMiss() {
    stats.cacheMisses += 1;
}

function recordScanTime(ms) {
    stats.scanTimes.push(ms);
    if (stats.scanTimes.length > 200) stats.scanTimes.shift();
}

function recordMarketDataTime(ms) {
    stats.marketDataTimes.push(ms);
    if (stats.marketDataTimes.length > 200) stats.marketDataTimes.shift();
}

function recordBacktestTime(ms) {
    stats.backtestTimes.push(ms);
    if (stats.backtestTimes.length > 100) stats.backtestTimes.shift();
}

function recordEngineRefresh() {
    stats.engineRefreshes += 1;
}

function recordSocketUpdate() {
    stats.socketUpdates += 1;
}

function average(values) {
    if (!values.length) return 0;
    return Number(
        (values.reduce((a, b) => a + b, 0) / values.length).toFixed(2),
    );
}

function getMetrics() {
    return {
        ...stats,
        avgScanTimeMs: average(stats.scanTimes),
        avgMarketDataTimeMs: average(stats.marketDataTimes),
        avgBacktestTimeMs: average(stats.backtestTimes),
        uptimeSeconds: Math.floor((Date.now() - stats.startedAt) / 1000),
    };
}

module.exports = {
    recordYahooRequest,
    recordCacheHit,
    recordCacheMiss,
    recordScanTime,
    recordMarketDataTime,
    recordBacktestTime,
    recordEngineRefresh,
    recordSocketUpdate,
    getMetrics,
};
