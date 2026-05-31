function normalizeSymbol(symbol = "") {
    return String(symbol).trim().toUpperCase();
}

/** Ensure Indian NSE-style symbols work with Yahoo (e.g. INFY -> INFY.NS). */
function ensureYahooSymbol(symbol, exchange) {
    const value = normalizeSymbol(symbol);

    if (!value) return value;
    if (value.includes(".")) return value;

    const ex = String(exchange || "").toUpperCase();

    if (ex === "NSI" || ex === "NSE" || ex === "BSE" || ex === "BOM") {
        return `${value}.NS`;
    }

    // Bare tickers from search (no suffix) — treat as NSE when short alphabetic
    if (/^[A-Z]{2,12}$/.test(value)) {
        return `${value}.NS`;
    }

    return value;
}

module.exports = {
    normalizeSymbol,
    ensureYahooSymbol,
};
