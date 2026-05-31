const YahooFinance = require("yahoo-finance2").default;
const { dedupe } = require("./requestDedup");
const { recordYahooRequest, recordCacheHit, recordCacheMiss } = require("./metrics");

const yahooFinance = new YahooFinance({
    suppressNotices: ["yahooSurvey"],
});

const CACHE_TTL_SECONDS = 300;
const cache = new Map();

const chartLimit = createConcurrencyLimit(3);

function createConcurrencyLimit(concurrency) {
    let active = 0;
    const queue = [];

    const runNext = () => {
        while (active < concurrency && queue.length > 0) {
            active += 1;
            const { fn, resolve, reject } = queue.shift();

            Promise.resolve()
                .then(fn)
                .then(resolve, reject)
                .finally(() => {
                    active -= 1;
                    runNext();
                });
        }
    };

    return (fn) =>
        new Promise((resolve, reject) => {
            queue.push({ fn, resolve, reject });
            runNext();
        });
}

function setCache(key, value, ttlSeconds = CACHE_TTL_SECONDS) {
    const expires = Date.now() + ttlSeconds * 1000;
    cache.set(key, { value, expires });
}

function getCache(key) {
    const item = cache.get(key);

    if (!item) {
        recordCacheMiss();
        return null;
    }

    if (Date.now() > item.expires) {
        cache.delete(key);
        recordCacheMiss();
        return null;
    }

    recordCacheHit();
    return item.value;
}

function isRateLimitError(error) {
    const message = String(error?.message || error || "").toLowerCase();

    return (
        message.includes("429") ||
        message.includes("too many requests") ||
        message.includes("rate limit")
    );
}

async function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(fn, maxAttempts = 3) {
    let lastError;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;

            if (!isRateLimitError(error) || attempt === maxAttempts - 1) {
                throw error;
            }

            const delayMs = 1000 * 2 ** attempt;
            await sleep(delayMs);
        }
    }

    throw lastError;
}

async function fetchChart(symbol, interval, periodDays) {
    const cacheKey = `${symbol}_${interval}_${periodDays}`;

    return dedupe(`chart:${cacheKey}`, async () => {
        const cached = getCache(cacheKey);
        if (cached) return cached;

        const period1 = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000);
        const period2 = new Date();

        recordYahooRequest();
        const chart = await chartLimit(() =>
            fetchWithRetry(() =>
                yahooFinance.chart(symbol, {
                    period1,
                    period2,
                    interval,
                }),
            ),
        );

        setCache(cacheKey, chart);
        return chart;
    });
}

async function fetchQuote(symbol) {
    const cacheKey = `${symbol}_quote`;

    return dedupe(`quote:${cacheKey}`, async () => {
        const cached = getCache(cacheKey);
        if (cached) return cached;

        recordYahooRequest();
        const quote = await chartLimit(() =>
            fetchWithRetry(() => yahooFinance.quote(symbol)),
        );

        setCache(cacheKey, quote, 60);
        return quote;
    });
}

async function searchSymbols(query) {
    const cacheKey = `search:${query.toLowerCase()}`;

    return dedupe(cacheKey, async () => {
        const cached = getCache(cacheKey);
        if (cached) return cached;

        recordYahooRequest();
        const results = await chartLimit(() =>
            fetchWithRetry(() => yahooFinance.search(query)),
        );

        setCache(cacheKey, results, 300);
        return results;
    });
}

async function fetchQuoteSummary(symbol, modules = ["summaryProfile"]) {
    const cacheKey = `${symbol}_summary_${modules.join("_")}`;

    return dedupe(cacheKey, async () => {
        const cached = getCache(cacheKey);
        if (cached) return cached;

        recordYahooRequest();
        const summary = await chartLimit(() =>
            fetchWithRetry(() =>
                yahooFinance.quoteSummary(symbol, { modules }),
            ),
        );

        setCache(cacheKey, summary, 3600);
        return summary;
    });
}

function deleteCache(key) {
    cache.delete(key);
}

module.exports = {
    yahooFinance,
    CACHE_TTL_SECONDS,
    setCache,
    getCache,
    deleteCache,
    chartLimit,
    fetchChart,
    fetchQuote,
    searchSymbols,
    fetchQuoteSummary,
    fetchWithRetry,
};
