const { recordCacheHit, recordCacheMiss } = require("../utils/metrics");

const store = new Map();

const TRACKED_FIELDS = [
    "symbol",
    "currency",
    "price",
    "change",
    "changeAmount",
    "volume",
    "volumeChange",
    "pe",
    "rsi",
    "prevRsi",
    "rsiChange",
    "hourlyRsi",
    "prevHourlyRsi",
    "hourlyRsiChange",
    "rsi15m",
    "prevRsi15m",
    "rsi15mChange",
    "rsi5m",
    "prevRsi5m",
    "rsi5mChange",
    "rsi1m",
    "prevRsi1m",
    "rsi1mChange",
    "ema20",
    "ema50",
    "ema200",
    "prevEma20",
    "prevEma50",
    "prevEma200",
    "prevPrice",
    "displayName",
];

function get(symbol) {
    const entry = store.get(symbol);
    if (!entry) {
        recordCacheMiss();
        return null;
    }
    recordCacheHit();
    return { ...entry.data, updatedAt: entry.updatedAt };
}

function has(symbol) {
    return store.has(symbol);
}

function set(symbol, data, layerTimestamps = {}) {
    const prev = store.get(symbol);
    const now = Date.now();

    const entry = {
        data: { ...data, symbol },
        updatedAt: now,
        priceUpdatedAt: layerTimestamps.priceUpdatedAt ?? prev?.priceUpdatedAt ?? now,
        rsiUpdatedAt: layerTimestamps.rsiUpdatedAt ?? prev?.rsiUpdatedAt ?? now,
        emaUpdatedAt: layerTimestamps.emaUpdatedAt ?? prev?.emaUpdatedAt ?? now,
        peUpdatedAt: layerTimestamps.peUpdatedAt ?? prev?.peUpdatedAt ?? now,
    };

    store.set(symbol, entry);

    return computeDelta(prev?.data, entry.data);
}

function merge(symbol, partial, layerTimestamps = {}) {
    const prev = store.get(symbol);
    const merged = { ...(prev?.data || { symbol }), ...partial, symbol };
    return set(symbol, merged, layerTimestamps);
}

function computeDelta(prev, next) {
    if (!prev || !next) {
        return { symbol: next.symbol, ...next, _full: true };
    }

    const delta = { symbol: next.symbol };
    let changed = false;

    TRACKED_FIELDS.forEach((field) => {
        if (field === "symbol") return;
        if (prev[field] !== next[field]) {
            delta[field] = next[field];
            changed = true;
        }
    });

    if (!changed) return null;

    delta.updatedAt = Date.now();
    return delta;
}

function getBatch(symbols) {
    return symbols
        .map((symbol) => get(symbol))
        .filter(Boolean);
}

function getSnapshot() {
    const out = {};
    store.forEach((entry, symbol) => {
        out[symbol] = {
            ...entry.data,
            updatedAt: entry.updatedAt,
        };
    });
    return out;
}

function remove(symbol) {
    store.delete(symbol);
}

function size() {
    return store.size;
}

function getMeta(symbol) {
    return store.get(symbol) || null;
}

module.exports = {
    get,
    has,
    set,
    merge,
    getBatch,
    getSnapshot,
    remove,
    size,
    getMeta,
    computeDelta,
};
