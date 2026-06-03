const invalidKeyCache = new Map();
const INVALID_KEY_TTL_MS = 24 * 60 * 60 * 1000;
const loggedInvalidKeys = new Set();

function getUpstoxMarketData() {
    return require("../services/marketDataService");
}

function isDerivativeType(instrumentType = "") {
    const type = String(instrumentType).toUpperCase();
    return (
        type.includes("FUT") ||
        type.includes("OPT") ||
        type === "CE" ||
        type === "PE" ||
        type === "CALL" ||
        type === "PUT"
    );
}

function isInvalidInstrumentMessage(message = "") {
    const text = String(message).toLowerCase();
    return text.includes("invalid instrument");
}

function isInstrumentKeyBlocked(instrumentKey) {
    if (!instrumentKey) return true;

    const entry = invalidKeyCache.get(instrumentKey);
    if (!entry) return false;

    if (Date.now() - entry.at > INVALID_KEY_TTL_MS) {
        invalidKeyCache.delete(instrumentKey);
        return false;
    }

    return true;
}

function markInstrumentKeyInvalid(instrumentKey, reason = "Invalid Instrument key") {
    if (!instrumentKey) return;

    invalidKeyCache.set(instrumentKey, {
        at: Date.now(),
        reason,
    });

    if (!loggedInvalidKeys.has(instrumentKey)) {
        loggedInvalidKeys.add(instrumentKey);
        console.log(
            `Upstox instrument key rejected (will skip candle retries): ${instrumentKey} — ${reason}. Re-add the symbol from search if this is an expired F&O contract.`,
        );
    }
}

function clearInstrumentKeyInvalid(instrumentKey) {
    if (!instrumentKey) return;
    invalidKeyCache.delete(instrumentKey);
    loggedInvalidKeys.delete(instrumentKey);
}

async function resolveStockInstrumentKey(stock = {}) {
    const upstox = getUpstoxMarketData();
    const storedKey = stock.instrumentKey;
    const symbol = String(stock.symbol || "").trim();

    if (storedKey && upstox.isValidInstrumentKey(storedKey)) {
        return {
            instrumentKey: storedKey,
            meta: upstox.getInstrumentMeta(storedKey),
            repaired: false,
        };
    }

    if (storedKey && isInstrumentKeyBlocked(storedKey)) {
        return null;
    }

    const query = symbol || storedKey;
    if (!query) return null;

    const results = await upstox.searchInstruments(query);
    if (!results.length) {
        if (storedKey) {
            markInstrumentKeyInvalid(
                storedKey,
                "Not found in Upstox instrument master (expired or wrong key)",
            );
        }
        return null;
    }

    const normalized = symbol.toUpperCase().replace(/\.(NS|BO)$/i, "");
    const preferredType = String(
        stock.instrumentType || stock.assetType || stock.type || "",
    ).toUpperCase();

    const exact = results.find((row) => {
        const sym = String(row.symbol || row.trading_symbol || "").toUpperCase();
        const type = String(row.instrumentType || row.type || "").toUpperCase();
        const keyMatch = storedKey && row.instrumentKey === storedKey;
        const symMatch =
            sym === normalized ||
            sym === symbol.toUpperCase() ||
            sym.replace(/-EQ$/i, "") === normalized;

        if (!symMatch && !keyMatch) return false;
        if (!preferredType) return true;
        return type === preferredType || type.includes(preferredType);
    });

    const pick = exact || results[0];
    if (!pick?.instrumentKey) return null;

    if (storedKey && storedKey !== pick.instrumentKey) {
        markInstrumentKeyInvalid(
            storedKey,
            `Replaced with current contract ${pick.instrumentKey}`,
        );
    } else {
        clearInstrumentKeyInvalid(pick.instrumentKey);
    }

    return {
        instrumentKey: pick.instrumentKey,
        meta: pick,
        repaired: Boolean(storedKey && storedKey !== pick.instrumentKey),
    };
}

async function resolveInstrumentKey(symbol, instrumentKey) {
    const upstox = getUpstoxMarketData();

    if (instrumentKey && upstox.isValidInstrumentKey(instrumentKey)) {
        return instrumentKey;
    }

    const resolved = await resolveStockInstrumentKey({
        symbol,
        instrumentKey,
    });

    return resolved?.instrumentKey || null;
}

async function canFetchCandles(instrumentKey) {
    if (!instrumentKey || isInstrumentKeyBlocked(instrumentKey)) {
        return false;
    }

    const upstox = getUpstoxMarketData();

    try {
        await upstox.loadInstruments();
    } catch {
        return !isInstrumentKeyBlocked(instrumentKey);
    }

    if (!upstox.isValidInstrumentKey(instrumentKey)) {
        markInstrumentKeyInvalid(
            instrumentKey,
            "Not in Upstox instrument master (expired F&O or stale key)",
        );
        return false;
    }

    return true;
}

module.exports = {
    isDerivativeType,
    isInvalidInstrumentMessage,
    isInstrumentKeyBlocked,
    markInstrumentKeyInvalid,
    clearInstrumentKeyInvalid,
    resolveStockInstrumentKey,
    resolveInstrumentKey,
    canFetchCandles,
};
