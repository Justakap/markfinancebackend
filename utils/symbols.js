function normalizeSymbol(symbol = "") {
    return String(symbol).trim().toUpperCase();
}

/** Normalize NSE equity symbols for search (no Yahoo suffix). */
function normalizeNseSymbol(symbol, exchange) {
    const value = normalizeSymbol(symbol).replace(/\.(NS|BO)$/i, "");

    if (!value) return value;

    const ex = String(exchange || "").toUpperCase();
    if (ex === "NSI" || ex === "NSE" || ex === "BSE" || ex === "BOM") {
        return value;
    }

    return value;
}

module.exports = {
    normalizeSymbol,
    normalizeNseSymbol,
};
