const expressRateLimit = require("express-rate-limit");

// Simple rate limiter per IP (used by search/market-data routes which need a high, debounce-friendly ceiling).
const rateMap = new Map();
const RATE_ENTRY_MAX_AGE_MS = 10 * 60 * 1000;

function rateLimit(ip, limit = 20, windowSec = 60) {
    const now = Date.now();
    const entry = rateMap.get(ip) || { count: 0, start: now };
    if (now - entry.start > windowSec * 1000) {
        entry.count = 0;
        entry.start = now;
    }
    entry.count += 1;
    rateMap.set(ip, entry);
    return entry.count <= limit;
}

// Stale IP entries must not grow the map forever.
const rateMapCleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of rateMap) {
        if (now - entry.start > RATE_ENTRY_MAX_AGE_MS) {
            rateMap.delete(key);
        }
    }
}, 5 * 60 * 1000);
rateMapCleanup.unref();

// Search is local (instrument master cache) — allow frequent debounced typing
function searchRateLimit(ip, limit = 120, windowSec = 60) {
    return rateLimit(`search:${ip}`, limit, windowSec);
}

// express-rate-limit (self-expiring store) for sensitive/expensive endpoints.
const authLimiter = expressRateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: "Too many login attempts. Try again later." },
});

const backtestLimiter = expressRateLimit({
    windowMs: 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: "Too many backtest requests. Wait a moment and retry." },
});

// Option-chain Upstox endpoint has no documented per-endpoint rate limit
// (Phase 2.0 audit) — kept conservative rather than assumed generous.
const optionChainLimiter = expressRateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: "Too many option-chain requests. Wait a moment and retry." },
});

// Generous safety net on all other mutating /api requests — not meant to bother normal usage.
const writeLimiter = expressRateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: "Too many requests. Please slow down." },
    skip: (req) => req.method === "GET",
});

module.exports = {
    rateLimit,
    searchRateLimit,
    authLimiter,
    backtestLimiter,
    optionChainLimiter,
    writeLimiter,
};
