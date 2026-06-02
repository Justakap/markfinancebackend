const axios = require("axios");

const peCache = new Map();
const PE_TTL_MS = Number(process.env.UPSTOX_PE_TTL_MS || 24 * 60 * 60 * 1000);
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

async function fetchPeByIsin(isin) {
    const token = getAccessToken();
    if (!token || !isin) return null;

    const response = await axios.get(
        `https://api.upstox.com/v2/fundamentals/${isin}/key-ratios`,
        {
            headers: {
                Accept: "application/json",
                Authorization: `Bearer ${token}`,
            },
            timeout: 15000,
        },
    );

    return parsePeValue(response.data?.data || []);
}

async function getPeForInstrument(instrumentKey, instrumentType = "") {
    if (!instrumentKey) return null;

    const type = String(instrumentType || "").toUpperCase();
    if (type && type !== "EQ" && type !== "ETF") {
        return null;
    }

    const cached = peCache.get(instrumentKey);
    if (cached && Date.now() - cached.updatedAt < PE_TTL_MS) {
        return cached.value;
    }

    if (pendingPe.has(instrumentKey)) {
        return pendingPe.get(instrumentKey);
    }

    const isin = isinFromInstrumentKey(instrumentKey);
    if (!isin) return null;

    const promise = fetchPeByIsin(isin)
        .then((value) => {
            peCache.set(instrumentKey, {
                value,
                updatedAt: Date.now(),
            });
            return value;
        })
        .catch((error) => {
            console.log(`PE fetch failed for ${instrumentKey}:`, error.message);
            peCache.set(instrumentKey, {
                value: null,
                updatedAt: Date.now(),
            });
            return null;
        })
        .finally(() => {
            pendingPe.delete(instrumentKey);
        });

    pendingPe.set(instrumentKey, promise);
    return promise;
}

async function warmPeForInstruments(stocks = []) {
    const equityStocks = stocks.filter((stock) => {
        const type = String(
            stock.instrumentType || stock.assetType || stock.type || "",
        ).toUpperCase();
        return !type || type === "EQ" || type === "ETF";
    });

    for (const stock of equityStocks.slice(0, 20)) {
        await getPeForInstrument(stock.instrumentKey, stock.instrumentType);
        await new Promise((resolve) => setTimeout(resolve, 120));
    }
}

function getCachedPe(instrumentKey) {
    const cached = peCache.get(instrumentKey);
    if (!cached || Date.now() - cached.updatedAt >= PE_TTL_MS) {
        return null;
    }
    return cached.value;
}

module.exports = {
    getPeForInstrument,
    getCachedPe,
    warmPeForInstruments,
    isinFromInstrumentKey,
};
