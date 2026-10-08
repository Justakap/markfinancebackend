const axios = require("axios");
const { enqueue } = require("../utils/upstoxRequestQueue");
const { createBoundedCache } = require("../utils/boundedCache");

/**
 * Upstox v2/option/chain and v2/option/contract integration.
 *
 * Mirrors fundamentalService.js's pattern (bounded TTL cache + an in-flight
 * pending-promise map for dedup) rather than introducing a new caching
 * mechanism. Option-chain data moves fast intraday, so its TTL is much
 * shorter than PE's 24h; contract/expiry lists are comparatively static
 * within a trading day, so they get a longer TTL, same as PE.
 *
 * Phase 2.0 did not find a documented per-endpoint rate limit for
 * option/chain, so this goes through the existing Upstox queue at default
 * ("background") priority like any other on-demand, user-facing lookup —
 * no special-cased limit is assumed.
 */

const OPTION_CHAIN_TTL_MS = Number(process.env.UPSTOX_OPTION_CHAIN_TTL_MS || 15 * 1000);
const OPTION_CHAIN_CACHE_MAX_SIZE = Number(process.env.UPSTOX_OPTION_CHAIN_CACHE_MAX_SIZE || 200);
const OPTION_CONTRACT_TTL_MS = Number(process.env.UPSTOX_OPTION_CONTRACT_TTL_MS || 24 * 60 * 60 * 1000);
const OPTION_CONTRACT_CACHE_MAX_SIZE = Number(process.env.UPSTOX_OPTION_CONTRACT_CACHE_MAX_SIZE || 500);

const optionChainCache = createBoundedCache({
    maxSize: OPTION_CHAIN_CACHE_MAX_SIZE,
    ttlMs: OPTION_CHAIN_TTL_MS,
});
const pendingOptionChain = new Map();

const optionContractCache = createBoundedCache({
    maxSize: OPTION_CONTRACT_CACHE_MAX_SIZE,
    ttlMs: OPTION_CONTRACT_TTL_MS,
});
const pendingOptionContract = new Map();

const EXPIRY_FORMAT = /^\d{4}-\d{2}-\d{2}$/;

function getAccessToken() {
    return process.env.UPSTOX_ACCESS_TOKEN || process.env.UPSTOX_TOKEN || "";
}

function isValidExpiryFormat(expiry) {
    if (!expiry || !EXPIRY_FORMAT.test(expiry)) return false;
    const parsed = new Date(`${expiry}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime());
}

function toNumberOrNull(value) {
    if (value === null || value === undefined || value === "") return null;
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
}

/** Defensive: never assume Upstox's nested shape is present — any missing
 *  branch simply yields nulls for that leg, never a thrown error. */
function normalizeLeg(leg) {
    if (!leg || typeof leg !== "object") return null;

    const marketData = leg.market_data || {};
    const greeks = leg.option_greeks || {};

    const oi = toNumberOrNull(marketData.oi);
    const previousOi = toNumberOrNull(marketData.prev_oi ?? marketData.previous_oi);

    return {
        instrumentKey: leg.instrument_key || null,
        ltp: toNumberOrNull(marketData.ltp),
        volume: toNumberOrNull(marketData.volume),
        oi,
        previousOi,
        oiChange: oi != null && previousOi != null ? oi - previousOi : null,
        bid: toNumberOrNull(marketData.bid_price),
        ask: toNumberOrNull(marketData.ask_price),
        iv: toNumberOrNull(greeks.iv),
        delta: toNumberOrNull(greeks.delta),
        gamma: toNumberOrNull(greeks.gamma),
        theta: toNumberOrNull(greeks.theta),
        vega: toNumberOrNull(greeks.vega),
        pop: toNumberOrNull(greeks.pop),
    };
}

function normalizeStrikeRow(row) {
    return {
        strike: toNumberOrNull(row?.strike_price),
        CE: normalizeLeg(row?.call_options),
        PE: normalizeLeg(row?.put_options),
    };
}

/** Upstox sometimes wraps the array differently across versions/errors —
 *  only ever treat a genuine array as strikes; anything else is an empty
 *  (not fabricated, not crashed) chain. */
function normalizeOptionChainResponse(instrumentKey, expiry, data) {
    const rows = Array.isArray(data) ? data : [];

    return {
        underlying: instrumentKey,
        expiry,
        strikes: rows.map(normalizeStrikeRow),
    };
}

async function fetchOptionChain(instrumentKey, expiry) {
    const token = getAccessToken();

    const response = await enqueue(() =>
        axios.get("https://api.upstox.com/v2/option/chain", {
            params: {
                instrument_key: instrumentKey,
                expiry_date: expiry,
            },
            headers: {
                Accept: "application/json",
                Authorization: `Bearer ${token}`,
            },
            timeout: 15000,
        }),
    );

    return normalizeOptionChainResponse(instrumentKey, expiry, response.data?.data);
}

async function getOptionChain(instrumentKey, expiry) {
    const cacheKey = `${instrumentKey}|${expiry}`;

    const cached = optionChainCache.get(cacheKey);
    if (cached !== undefined) {
        return cached;
    }

    if (pendingOptionChain.has(cacheKey)) {
        return pendingOptionChain.get(cacheKey);
    }

    const promise = fetchOptionChain(instrumentKey, expiry)
        .then((value) => {
            optionChainCache.set(cacheKey, value);
            return value;
        })
        .finally(() => {
            pendingOptionChain.delete(cacheKey);
        });

    pendingOptionChain.set(cacheKey, promise);
    return promise;
}

function normalizeContractsResponse(data) {
    const rows = Array.isArray(data) ? data : [];
    const expirySet = new Set();

    rows.forEach((row) => {
        if (row?.expiry) expirySet.add(row.expiry);
    });

    return [...expirySet].sort();
}

async function fetchOptionContracts(instrumentKey) {
    const token = getAccessToken();

    const response = await enqueue(() =>
        axios.get("https://api.upstox.com/v2/option/contract", {
            params: { instrument_key: instrumentKey },
            headers: {
                Accept: "application/json",
                Authorization: `Bearer ${token}`,
            },
            timeout: 15000,
        }),
    );

    return normalizeContractsResponse(response.data?.data);
}

async function getOptionExpiries(instrumentKey) {
    const cached = optionContractCache.get(instrumentKey);
    if (cached !== undefined) {
        return cached;
    }

    if (pendingOptionContract.has(instrumentKey)) {
        return pendingOptionContract.get(instrumentKey);
    }

    const promise = fetchOptionContracts(instrumentKey)
        .then((value) => {
            optionContractCache.set(instrumentKey, value);
            return value;
        })
        .finally(() => {
            pendingOptionContract.delete(instrumentKey);
        });

    pendingOptionContract.set(instrumentKey, promise);
    return promise;
}

module.exports = {
    isValidExpiryFormat,
    getOptionChain,
    getOptionExpiries,
    normalizeOptionChainResponse,
    normalizeStrikeRow,
    normalizeLeg,
};
