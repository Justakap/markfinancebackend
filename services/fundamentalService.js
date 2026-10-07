const axios = require("axios");
const { enqueue } = require("../utils/upstoxRequestQueue");
const { createBoundedCache } = require("../utils/boundedCache");

const PE_TTL_MS = Number(process.env.UPSTOX_PE_TTL_MS || 24 * 60 * 60 * 1000);
const PE_CACHE_MAX_SIZE = Number(process.env.UPSTOX_PE_CACHE_MAX_SIZE || 2000);

/** PE ratio per instrument key. Purpose: avoid refetching Upstox fundamentals
 *  on every watchlist refresh. TTL 24h (env-tunable), max 2000 instruments,
 *  LRU-evicted by set() and swept in the background — never grows unbounded. */
const peCache = createBoundedCache({
    maxSize: PE_CACHE_MAX_SIZE,
    ttlMs: PE_TTL_MS,
});
const pendingPe = new Map();

function getAccessToken() {
    return process.env.UPSTOX_ACCESS_TOKEN || process.env.UPSTOX_TOKEN || "";
}

function isinFromInstrumentKey(instrumentKey = "") {
    const parts = String(instrumentKey).split("|");
    const isin = parts[1] || "";
    return /^INE[A-Z0-9]{9}$/i.test(isin) ? isin.toUpperCase() : "";
}

function parsePeValue(ratios = []) {
    const entry = ratios.find(
        (item) => String(item.name || "").toUpperCase() === "P/E",
    );
    if (!entry?.company_value) return null;

    const value = Number(String(entry.company_value).replace(/,/g, ""));
    return Number.isFinite(value) ? value : null;
}

async function fetchPeByIsin(isin, { priority } = {}) {
    const token = getAccessToken();
    if (!token || !isin) return null;

    const response = await enqueue(
        () =>
            axios.get(`https://api.upstox.com/v2/fundamentals/${isin}/key-ratios`, {
                headers: {
                    Accept: "application/json",
                    Authorization: `Bearer ${token}`,
                },
                timeout: 15000,
            }),
        { priority },
    );

    return parsePeValue(response.data?.data || []);
}

/**
 * `options.priority`: passed straight through to the underlying Upstox
 * queue call. Callers needing PE to fulfill a direct, awaited request
 * (watchlist/backtest routes, strategy scans, `buildRow`'s on-demand
 * lookup) should leave this unset (default queue priority) so they're
 * never held up by background warming. `warmPeForInstruments` (below)
 * explicitly passes `"low"` since it's fire-and-forget and must never
 * compete with indicator candle requests.
 */
async function getPeForInstrument(instrumentKey, instrumentType = "", options = {}) {
    if (!instrumentKey) return null;

    const type = String(instrumentType || "").toUpperCase();
    if (type && type !== "EQ" && type !== "ETF") {
        return null;
    }

    const cached = peCache.get(instrumentKey);
    if (cached !== undefined) {
        return cached;
    }

    if (pendingPe.has(instrumentKey)) {
        return pendingPe.get(instrumentKey);
    }

    const isin = isinFromInstrumentKey(instrumentKey);
    if (!isin) return null;

    const promise = fetchPeByIsin(isin, { priority: options.priority })
        .then((value) => {
            peCache.set(instrumentKey, value);
            return value;
        })
        .catch((error) => {
            console.log(`PE fetch failed for ${instrumentKey}:`, error.message);
            peCache.set(instrumentKey, null);
            return null;
        })
        .finally(() => {
            pendingPe.delete(instrumentKey);
        });

    pendingPe.set(instrumentKey, promise);
    return promise;
}

/**
 * Fire-and-forget bulk PE pre-fetch for a watchlist. Runs at the lowest
 * queue priority ("low") so it can never delay LTP ("critical") or
 * indicator candle fetches ("background") — it only gets a queue turn once
 * both of those lanes are empty. PE data still populates normally; it's
 * just never allowed to compete with what the UI needs first.
 */
async function warmPeForInstruments(stocks = []) {
    const equityStocks = stocks.filter((stock) => {
        const type = String(
            stock.instrumentType || stock.assetType || stock.type || "",
        ).toUpperCase();
        return !type || type === "EQ" || type === "ETF";
    });

    for (const stock of equityStocks.slice(0, 20)) {
        await getPeForInstrument(stock.instrumentKey, stock.instrumentType, { priority: "low" });
        await new Promise((resolve) => setTimeout(resolve, 120));
    }
}

function getCachedPe(instrumentKey) {
    const cached = peCache.get(instrumentKey);
    return cached === undefined ? null : cached;
}

module.exports = {
    getPeForInstrument,
    getCachedPe,
    warmPeForInstruments,
    isinFromInstrumentKey,
};
