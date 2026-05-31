const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const ET_OFFSET_MS = -5 * 60 * 60 * 1000;
const AEST_OFFSET_MS = 10 * 60 * 60 * 1000;

const NSE_HOLIDAYS_2026 = new Set([
    "2026-01-26",
    "2026-03-10",
    "2026-03-30",
    "2026-03-31",
    "2026-04-02",
    "2026-04-14",
    "2026-05-01",
    "2026-08-15",
    "2026-10-02",
    "2026-10-20",
    "2026-11-08",
    "2026-11-24",
    "2026-12-25",
]);

function toOffsetDate(date, offsetMs) {
    return new Date(date.getTime() + offsetMs);
}

function formatDay(date, offsetMs) {
    const local = toOffsetDate(date, offsetMs);
    const y = local.getUTCFullYear();
    const m = String(local.getUTCMonth() + 1).padStart(2, "0");
    const d = String(local.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
}

function getLocalMinutes(date, offsetMs) {
    const local = toOffsetDate(date, offsetMs);
    return local.getUTCHours() * 60 + local.getUTCMinutes();
}

function getLocalDay(date, offsetMs) {
    return toOffsetDate(date, offsetMs).getUTCDay();
}

function inferMarketType(symbol = "", market = "") {
    const m = String(market || "").toUpperCase().trim();
    const s = String(symbol || "").toUpperCase().trim();

    if (
        m === "CRYPTO" ||
        m === "CCC" ||
        m === "CCY" ||
        s.includes("-USD") ||
        s.includes("-EUR") ||
        s.includes("-BTC")
    ) {
        return "crypto";
    }

    if (
        m === "NASDAQ" ||
        m === "NYSE" ||
        m === "DOW JONES" ||
        m === "NMS" ||
        m === "NYQ" ||
        m === "DJI"
    ) {
        return "us";
    }

    if (m === "ASX" || s.endsWith(".AX")) {
        return "asx";
    }

    if (m === "BSE" || m === "BOM" || s.endsWith(".BO")) {
        return "bse";
    }

    if (m === "NSE" || m === "NSI" || s.endsWith(".NS")) {
        return "nse";
    }

    if (/^[A-Z]{1,5}$/.test(s) && !s.includes(".")) {
        return "us";
    }

    return "nse";
}

function getNseMarketStatus(date = new Date()) {
    const day = getLocalDay(date, IST_OFFSET_MS);
    if (day === 0 || day === 6) {
        return { status: "weekend", isOpen: false, label: "NSE Closed" };
    }

    if (NSE_HOLIDAYS_2026.has(formatDay(date, IST_OFFSET_MS))) {
        return { status: "holiday", isOpen: false, label: "NSE Holiday" };
    }

    const minutes = getLocalMinutes(date, IST_OFFSET_MS);

    if (minutes >= 555 && minutes < 570) {
        return { status: "pre_open", isOpen: false, label: "NSE Pre Open" };
    }

    if (minutes >= 570 && minutes < 915) {
        return { status: "open", isOpen: true, label: "NSE Open" };
    }

    if (minutes >= 915 && minutes < 960) {
        return { status: "post_market", isOpen: false, label: "NSE Post Market" };
    }

    return { status: "closed", isOpen: false, label: "NSE Closed" };
}

function getBseMarketStatus(date = new Date()) {
    const status = getNseMarketStatus(date);
    return {
        ...status,
        label: status.label.replace("NSE", "BSE"),
    };
}

function getUsMarketStatus(date = new Date()) {
    const day = getLocalDay(date, ET_OFFSET_MS);
    if (day === 0 || day === 6) {
        return { status: "weekend", isOpen: false, label: "US Closed" };
    }

    const minutes = getLocalMinutes(date, ET_OFFSET_MS);

    if (minutes >= 570 && minutes < 960) {
        return { status: "open", isOpen: true, label: "US Open" };
    }

    if (minutes >= 240 && minutes < 570) {
        return { status: "pre_market", isOpen: false, label: "US Pre Market" };
    }

    if (minutes >= 960 && minutes < 1200) {
        return { status: "post_market", isOpen: false, label: "US Post Market" };
    }

    return { status: "closed", isOpen: false, label: "US Closed" };
}

function getAsxMarketStatus(date = new Date()) {
    const day = getLocalDay(date, AEST_OFFSET_MS);
    if (day === 0 || day === 6) {
        return { status: "weekend", isOpen: false, label: "ASX Closed" };
    }

    const minutes = getLocalMinutes(date, AEST_OFFSET_MS);

    if (minutes >= 600 && minutes < 960) {
        return { status: "open", isOpen: true, label: "ASX Open" };
    }

    return { status: "closed", isOpen: false, label: "ASX Closed" };
}

function getCryptoMarketStatus() {
    return { status: "open", isOpen: true, label: "Crypto 24/7" };
}

function getMarketStatusByType(type, date = new Date()) {
    switch (type) {
        case "crypto":
            return getCryptoMarketStatus(date);
        case "us":
            return getUsMarketStatus(date);
        case "asx":
            return getAsxMarketStatus(date);
        case "bse":
            return getBseMarketStatus(date);
        case "nse":
        default:
            return getNseMarketStatus(date);
    }
}

function getMarketStatusForSymbol(symbol, market, date = new Date()) {
    return getMarketStatusByType(inferMarketType(symbol, market), date);
}

function getRefreshIntervalsForSymbol(symbol, market, date = new Date()) {
    const type = inferMarketType(symbol, market);
    const status = getMarketStatusByType(type, date);

    if (type === "crypto") {
        return {
            priceMs: 8_000,
            rsiMs: 60_000,
            emaMs: 60_000,
            peMs: 86_400_000,
        };
    }

    if (status.isOpen) {
        const priceMs = type === "nse" || type === "bse" ? 10_000 : 15_000;
        return {
            priceMs,
            rsiMs: 60_000,
            emaMs: 60_000,
            peMs: 86_400_000,
        };
    }

    return {
        priceMs: 300_000,
        rsiMs: 300_000,
        emaMs: 300_000,
        peMs: 86_400_000,
    };
}

function getMarketStatus(date = new Date()) {
    return getNseMarketStatus(date);
}

function getRefreshIntervals(date = new Date()) {
    return getRefreshIntervalsForSymbol("", "NSE", date);
}

function getCombinedMarketStatus(date = new Date()) {
    const nse = getNseMarketStatus(date);
    const us = getUsMarketStatus(date);
    const crypto = getCryptoMarketStatus(date);

    const open = [];
    if (nse.isOpen) open.push("NSE");
    if (us.isOpen) open.push("US");
    open.push("Crypto");

    return {
        nse,
        us,
        crypto,
        label: open.length ? `${open.join(" · ")} active` : "Markets closed",
    };
}

module.exports = {
    inferMarketType,
    getMarketStatus,
    getMarketStatusByType,
    getMarketStatusForSymbol,
    getRefreshIntervals,
    getRefreshIntervalsForSymbol,
    getCombinedMarketStatus,
    formatIstDay: (date) => formatDay(date, IST_OFFSET_MS),
};
