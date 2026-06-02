const axios = require("axios");
const crypto = require("crypto");
const path = require("path");
const protobuf = require("protobufjs");
const WebSocket = require("ws");
const zlib = require("zlib");
const { getCandles, warmCandles } = require("./candleService");
const {
    calculateEMA,
    calculateRSI,
} = require("./indicatorService");
const {
    getCachedPe,
    getPeForInstrument,
    warmPeForInstruments,
} = require("./fundamentalService");

const INSTRUMENT_MASTER_URL =
    process.env.UPSTOX_INSTRUMENT_MASTER_URL ||
    "https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz";

const liveData = new Map();
const indicatorSnapshot = new Map();
const subscribedInstruments = new Set();
const instrumentMeta = new Map();
const searchResultCache = new Map();
const SEARCH_CACHE_TTL_MS = 30 * 1000;
const INDICATOR_REFRESH_MS = Number(
    process.env.UPSTOX_INDICATOR_REFRESH_MS || 8 * 1000,
);
const TICK_INDICATOR_DEBOUNCE_MS = Number(
    process.env.UPSTOX_TICK_INDICATOR_DEBOUNCE_MS || 200,
);

const RSI_TF_CONFIG = [
    {
        tf: "5m",
        interval: "minutes",
        unit: "5",
        rsi: "rsi5m",
        prev: "prevRsi5m",
        change: "rsi5mChange",
    },
    {
        tf: "15m",
        interval: "minutes",
        unit: "15",
        rsi: "rsi15m",
        prev: "prevRsi15m",
        change: "rsi15mChange",
    },
    {
        tf: "1h",
        interval: "hours",
        unit: "1",
        rsi: "hourlyRsi",
        prev: "prevHourlyRsi",
        change: "hourlyRsiChange",
    },
    {
        tf: "1d",
        interval: "days",
        unit: "1",
        rsi: "rsi",
        prev: "prevRsi",
        change: "rsiChange",
    },
];

let io = null;
let ws = null;
let feedResponseType = null;
let instrumentsCache = null;
let instrumentsLoadedAt = 0;
let connecting = false;
let reconnectTimer = null;
let indicatorTimer = null;
let ltpPollTimer = null;
let socketConnected = false;
const pendingRealtimeIndicatorTimers = new Map();
const realtimeIndicatorInFlight = new Map();
const LTP_POLL_MS = Number(process.env.UPSTOX_LTP_POLL_MS || 2 * 1000);
const WS_RECONNECT_MS = Number(process.env.UPSTOX_WS_RECONNECT_MS || 5 * 1000);

function getAccessToken() {
    return process.env.UPSTOX_ACCESS_TOKEN || process.env.UPSTOX_TOKEN || "";
}

function normalizeInstrument(item) {
    const symbol = item.trading_symbol || item.tradingsymbol || item.symbol || "";
    const name = item.name || item.short_name || symbol;
    const exchange = item.exchange || item.segment || "";
    const instrumentType = item.instrument_type || item.instrumentType || "";

    return {
        symbol,
        name,
        instrumentKey: item.instrument_key || item.instrumentKey,
        exchange,
        type: instrumentType,
        instrumentType,
        segment: item.segment || "",
        shortName: item.short_name || "",
        isin: item.isin || "",
        sector: formatSectorLabel(item),
    };
}

function formatSectorLabel(item = {}) {
    const segment = item.segment || "";
    const exchange = item.exchange || "";
    const type = item.instrument_type || item.instrumentType || "";

    if (segment) return segment;
    if (exchange && type) return `${exchange} · ${type}`;
    return exchange || type || "Other";
}

function resolveStockSector(stock) {
    if (stock.sector) return stock.sector;

    const meta = instrumentMeta.get(stock.instrumentKey) || {};
    if (meta.sector) return meta.sector;

    const exchange = stock.exchange || stock.market || "";
    const type = stock.instrumentType || stock.assetType || stock.type || "";

    if (exchange && type) return `${exchange} · ${type}`;
    return exchange || type || "Other";
}

async function computeAllRsiFields(instrumentKey) {
    if (!instrumentKey) return {};

    const fields = {};
    const live = liveData.get(instrumentKey) || {};

    await mapWithLimit(RSI_TF_CONFIG, 2, async (cfg) => {
        const candles = await getCandles(instrumentKey, {
            interval: cfg.interval,
            unit: cfg.unit,
        }).catch(() => []);

        const candlesWithLive =
            cfg.tf === "1d"
                ? appendLivePriceAsCurrentCandle(candles, live.ltp)
                : mergeLivePriceIntoLatestCandle(candles, live.ltp);
        const result = calculateRSI(
            candlesWithLive,
            14,
            `${instrumentKey}:${cfg.tf}`,
        );
        fields[cfg.rsi] = result.rsi;
        fields[cfg.prev] = result.prevRsi;
        fields[cfg.change] = result.rsiChange;
    });

    return fields;
}

function isSupportedInstrument(item) {
    const segment = String(item.segment || "").toUpperCase();
    const type = String(item.instrument_type || item.instrumentType || "").toUpperCase();

    return (
        type === "EQ" ||
        type === "INDEX" ||
        type.includes("FUT") ||
        type.includes("OPT") ||
        type === "CE" ||
        type === "PE" ||
        type === "CALL" ||
        type === "PUT" ||
        type === "ETF" ||
        segment.includes("NSE_FO") ||
        segment.includes("BSE_FO") ||
        segment.includes("MCX") ||
        segment.includes("BCD") ||
        segment.includes("NCD") ||
        segment.includes("NSE_COM")
    );
}

async function loadFeedProto() {
    if (feedResponseType) return feedResponseType;

    const root = await protobuf.load(
        path.join(__dirname, "../proto/MarketDataFeedV3.proto"),
    );

    feedResponseType = root.lookupType(
        "com.upstox.marketdatafeederv3udapi.rpc.proto.FeedResponse",
    );

    return feedResponseType;
}

async function loadInstruments(force = false) {
    const oneDay = 24 * 60 * 60 * 1000;

    if (
        instrumentsCache &&
        !force &&
        Date.now() - instrumentsLoadedAt < oneDay
    ) {
        return instrumentsCache;
    }

    const response = await axios.get(INSTRUMENT_MASTER_URL, {
        responseType: "arraybuffer",
        timeout: 30000,
    });

    const buffer = Buffer.from(response.data);
    const body = INSTRUMENT_MASTER_URL.endsWith(".gz")
        ? zlib.gunzipSync(buffer).toString("utf8")
        : buffer.toString("utf8");

    instrumentsCache = JSON.parse(body)
        .filter((item) => item.instrument_key && isSupportedInstrument(item))
        .map(normalizeInstrument);

    instrumentMeta.clear();
    instrumentsCache.forEach((instrument) => {
        instrumentMeta.set(instrument.instrumentKey, instrument);
    });

    instrumentsLoadedAt = Date.now();
    return instrumentsCache;
}

function rankSearchResults(items, q) {
    const tokens = q.split(/\s+/).filter(Boolean);
    return items
        .sort((a, b) => {
            const aSymbol = a.symbol.toUpperCase();
            const bSymbol = b.symbol.toUpperCase();
            const aText = `${a.symbol} ${a.name} ${a.instrumentKey} ${a.segment || ""}`.toUpperCase();
            const bText = `${b.symbol} ${b.name} ${b.instrumentKey} ${b.segment || ""}`.toUpperCase();

            const aTokenHits = tokens.reduce(
                (count, token) => count + (aText.includes(token) ? 1 : 0),
                0,
            );
            const bTokenHits = tokens.reduce(
                (count, token) => count + (bText.includes(token) ? 1 : 0),
                0,
            );
            if (aTokenHits !== bTokenHits) return bTokenHits - aTokenHits;

            const aStarts = aSymbol.startsWith(q) ? 0 : 1;
            const bStarts = bSymbol.startsWith(q) ? 0 : 1;
            if (aStarts !== bStarts) return aStarts - bStarts;

            const aExact = aSymbol === q ? 0 : 1;
            const bExact = bSymbol === q ? 0 : 1;
            if (aExact !== bExact) return aExact - bExact;

            return a.symbol.localeCompare(b.symbol);
        })
        .slice(0, 40);
}

async function searchInstruments(query) {
    const q = String(query || "").trim().toUpperCase();
    if (q.length < 2) return [];
    const tokens = q.split(/\s+/).filter(Boolean);

    const cacheKey = q;
    const cached = searchResultCache.get(cacheKey);
    if (cached && Date.now() - cached.updatedAt < SEARCH_CACHE_TTL_MS) {
        return cached.results;
    }

    const matchInstruments = (instruments = []) =>
        instruments.filter((item) => {
            const symbol = item.symbol.toUpperCase();
            const name = item.name.toUpperCase();
            const key = item.instrumentKey.toUpperCase();

            if (symbol.includes(q) || name.includes(q) || key.includes(q)) {
                return true;
            }

            const text =
                `${symbol} ${name} ${key} ${(item.segment || "").toUpperCase()}`.trim();
            return tokens.every((token) => text.includes(token));
        });

    let instruments = await loadInstruments();
    let matched = matchInstruments(instruments);
    if (!matched.length) {
        instruments = await loadInstruments(true);
        matched = matchInstruments(instruments);
    }

    const results = rankSearchResults(matched, q);

    searchResultCache.set(cacheKey, {
        results,
        updatedAt: Date.now(),
    });

    return results;
}

async function authorizeFeed() {
    const token = getAccessToken();
    if (!token) {
        throw new Error("Missing UPSTOX_ACCESS_TOKEN in backend .env");
    }

    const response = await axios.get(
        "https://api.upstox.com/v3/feed/market-data-feed/authorize",
        {
            headers: {
                Accept: "application/json",
                Authorization: `Bearer ${token}`,
            },
            timeout: 15000,
        },
    );

    const authorizedRedirectUri =
        response.data?.data?.authorizedRedirectUri ||
        response.data?.authorizedRedirectUri;

    if (!authorizedRedirectUri) {
        throw new Error("Upstox authorize response missing authorizedRedirectUri");
    }

    return authorizedRedirectUri;
}

function scheduleFeedReconnect() {
    if (reconnectTimer) return;

    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectFeed();
    }, WS_RECONNECT_MS);
}

async function connectFeed() {
    if (connecting || ws?.readyState === WebSocket.OPEN) return;

    const token = getAccessToken();
    if (!token) return;

    connecting = true;

    try {
        await loadFeedProto();
        const url = await authorizeFeed();

        // Upstox authorize URL already includes credentials — do not add Bearer header (causes 403).
        ws = new WebSocket(url);

        ws.on("open", () => {
            connecting = false;
            socketConnected = true;
            console.log("Upstox V3 feed connected (socket)");
            sendSubscription([...subscribedInstruments], "sub");
        });

        ws.on("message", (data) => {
            decodeFeed(data)
                .then((ticks) => {
                    ticks.forEach((tick) => {
                        handleTick(tick);
                    });
                })
                .catch((error) => {
                    console.log("Upstox decode error:", error.message);
                });
        });

        ws.on("close", () => {
            console.log("Upstox V3 feed disconnected");
            socketConnected = false;
            ws = null;
            connecting = false;
            scheduleFeedReconnect();
        });

        ws.on("error", (error) => {
            console.log("Upstox V3 feed error:", error.message);
            connecting = false;
            socketConnected = false;
        });
    } catch (error) {
        connecting = false;
        socketConnected = false;
        console.log("Upstox feed connect failed:", error.message);
        scheduleFeedReconnect();
    }
}

function sendSubscription(instrumentKeys, method = "sub") {
    if (!instrumentKeys.length || ws?.readyState !== WebSocket.OPEN) return;

    // full_d5 includes MarketFullFeed.vtt (day volume). ltpc mode only sends LTPC (no volume) per proto.
    const payload = {
        guid: crypto.randomUUID(),
        method,
        data: {
            mode: process.env.UPSTOX_FEED_MODE || "ltpc",
            instrumentKeys,
        },
    };

    ws.send(Buffer.from(JSON.stringify(payload)));
}

function toNum(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

function isValidLtp(ltp) {
    return Number.isFinite(ltp) && ltp > 0;
}

function mergeLivePriceIntoLatestCandle(candles = [], ltp) {
    if (!Array.isArray(candles) || !candles.length || !isValidLtp(ltp)) {
        return candles;
    }

    const next = candles.map((candle) => ({ ...candle }));
    const lastIndex = next.length - 1;
    const last = next[lastIndex];

    next[lastIndex] = {
        ...last,
        close: ltp,
        high: Number.isFinite(last.high) ? Math.max(last.high, ltp) : ltp,
        low: Number.isFinite(last.low) ? Math.min(last.low, ltp) : ltp,
    };

    return next;
}

function appendLivePriceAsCurrentCandle(candles = [], ltp) {
    if (!Array.isArray(candles) || !candles.length || !isValidLtp(ltp)) {
        return candles;
    }

    const next = candles.map((candle) => ({ ...candle }));
    const last = next[next.length - 1];
    const baseClose = Number.isFinite(last.close) ? last.close : ltp;

    next.push({
        timestamp: new Date().toISOString(),
        open: baseClose,
        high: Math.max(baseClose, ltp),
        low: Math.min(baseClose, ltp),
        close: ltp,
        volume: 0,
        oi: Number.isFinite(last.oi) ? last.oi : 0,
    });

    return next.slice(-250);
}

/** Walk decoded Feed union — full_d5 nests LTPC under fullFeed.marketFf, not item.ltpc */
function extractLtpcFromFeedItem(item) {
    if (!item || typeof item !== "object") return {};

    const full = item.fullFeed || item.fullfeed || {};
    const first = item.firstLevelWithGreeks || {};
    const marketFF = full.marketFF || full.marketFf || item.marketFF || item.marketFf || {};
    const indexFF = full.indexFF || full.indexFf || {};

    const direct = [
        item.ltpc,
        first.ltpc,
        marketFF.ltpc,
        indexFF.ltpc,
    ].filter(Boolean);

    for (const node of direct) {
        if (isValidLtp(toNum(node.ltp))) return node;
    }

    const stack = [item];
    const seen = new Set();

    while (stack.length) {
        const cur = stack.pop();
        if (!cur || typeof cur !== "object" || seen.has(cur)) continue;
        seen.add(cur);

        if (
            cur.ltp != null &&
            isValidLtp(toNum(cur.ltp)) &&
            (cur.cp != null || cur.ltt != null || cur.ltq != null)
        ) {
            return cur;
        }

        for (const value of Object.values(cur)) {
            if (value && typeof value === "object") stack.push(value);
        }
    }

    return direct[0] || {};
}

function extractVolumeFromFeedItem(item, ltpc) {
    const full = item.fullFeed || item.fullfeed || {};
    const first = item.firstLevelWithGreeks || {};
    const marketFF = full.marketFF || full.marketFf || item.marketFF || item.marketFf || {};

    // Volume column must represent total traded volume for the day (VTT),
    // never the last traded quantity (LTQ).
    return toNum(marketFF.vtt || first.vtt || 0);
}

async function decodeFeed(data) {
    const FeedResponse = await loadFeedProto();
    const decoded = FeedResponse.decode(Buffer.from(data));
    const feed = FeedResponse.toObject(decoded, {
        longs: String,
        enums: String,
        defaults: true,
    });

    return Object.entries(feed.feeds || {})
        .map(([instrumentKey, item]) => {
            const ltpc = extractLtpcFromFeedItem(item);
            const meta = instrumentMeta.get(instrumentKey) || {};
            const cp = toNum(ltpc.cp);
            const ltp = toNum(ltpc.ltp);
            const changeAmount = cp && ltp ? Number((ltp - cp).toFixed(2)) : 0;
            const changePercent =
                cp && ltp ? Number((((ltp - cp) / cp) * 100).toFixed(2)) : 0;
            const volume = extractVolumeFromFeedItem(item, ltpc);

            if (!isValidLtp(ltp) && volume <= 0) {
                return null;
            }

            return {
                instrumentKey,
                symbol: meta.symbol || instrumentKey,
                ltp: isValidLtp(ltp) ? ltp : undefined,
                changeAmount: isValidLtp(ltp) ? changeAmount : undefined,
                changePercent: isValidLtp(ltp) ? changePercent : undefined,
                volume: volume > 0 ? volume : undefined,
                lastTradeTime: ltpc.ltt || feed.currentTs || Date.now(),
                oi: toNum(
                    (item.fullFeed?.marketFF || item.fullFeed?.marketFf || {})
                        .oi || item.firstLevelWithGreeks?.oi,
                ),
            };
        })
        .filter(Boolean);
}

function emitMarketTick(tick, snapshot = {}) {
    const meta = instrumentMeta.get(tick.instrumentKey) || {};
    const previous = liveData.get(tick.instrumentKey) || {};
    const ltp = isValidLtp(tick.ltp) ? tick.ltp : previous.ltp;
    const volume =
        tick.volume != null && tick.volume > 0 ? tick.volume : previous.volume;

    io?.emit("marketTick", {
        instrumentKey: tick.instrumentKey,
        symbol: snapshot.symbol || meta.symbol || tick.symbol,
        name: snapshot.name || meta.name || "",
        ltp,
        price: ltp,
        changeAmount:
            tick.changeAmount != null ? tick.changeAmount : previous.changeAmount,
        changePercent:
            tick.changePercent != null
                ? tick.changePercent
                : previous.changePercent,
        change:
            tick.changePercent != null
                ? tick.changePercent
                : previous.changePercent,
        volume,
        timestamp: tick.timestamp || previous.timestamp,
        ema20: snapshot.ema20 ?? null,
        rsi: snapshot.rsi ?? null,
        prevRsi: snapshot.prevRsi ?? null,
        rsiChange: snapshot.rsiChange ?? null,
        rsi5m: snapshot.rsi5m ?? null,
        prevRsi5m: snapshot.prevRsi5m ?? null,
        rsi5mChange: snapshot.rsi5mChange ?? null,
        rsi15m: snapshot.rsi15m ?? null,
        prevRsi15m: snapshot.prevRsi15m ?? null,
        rsi15mChange: snapshot.rsi15mChange ?? null,
        hourlyRsi: snapshot.hourlyRsi ?? null,
        prevHourlyRsi: snapshot.prevHourlyRsi ?? null,
        hourlyRsiChange: snapshot.hourlyRsiChange ?? null,
        pe: snapshot.pe ?? getCachedPe(tick.instrumentKey),
    });
}

async function refreshIndicatorsForKey(instrumentKey) {
    const meta = instrumentMeta.get(instrumentKey) || {};
    const stock = {
        ...meta,
        instrumentKey,
        symbol: meta.symbol || instrumentKey,
    };

    const row = await buildRow(stock, { includePe: false });
    const snapshot = pickIndicatorSnapshot(row);

    indicatorSnapshot.set(instrumentKey, snapshot);

    const live = liveData.get(instrumentKey);
    if (live) {
        emitMarketTick(live, snapshot);
    }

    return snapshot;
}

function handleTick(tick) {
    if (!tick?.instrumentKey) return;

    const previous = liveData.get(tick.instrumentKey) || {};
    const next = {
        ...previous,
        instrumentKey: tick.instrumentKey,
        timestamp: Date.now(),
    };

    if (isValidLtp(tick.ltp)) {
        next.ltp = tick.ltp;
        next.changeAmount = tick.changeAmount;
        next.changePercent = tick.changePercent;
    }

    if (tick.volume != null && tick.volume > 0) {
        next.volume = Math.max(Number(previous.volume || 0), Number(tick.volume));
    }

    if (tick.oi != null) {
        next.oi = tick.oi;
    }

    liveData.set(tick.instrumentKey, next);

    const snapshot = indicatorSnapshot.get(tick.instrumentKey) || {};
    emitMarketTick(next, snapshot);
    scheduleRealtimeIndicatorRefresh(tick.instrumentKey);
}

async function refreshRealtimeIndicatorsForKey(instrumentKey) {
    const existing = realtimeIndicatorInFlight.get(instrumentKey);
    if (existing) {
        return existing;
    }

    const task = (async () => {
        const live = liveData.get(instrumentKey) || {};
        if (!isValidLtp(live.ltp)) {
            return indicatorSnapshot.get(instrumentKey) || {};
        }

        const meta = instrumentMeta.get(instrumentKey) || {};
        const stock = {
            ...meta,
            instrumentKey,
            symbol: meta.symbol || instrumentKey,
        };

        const dailyCandles = await getCandles(instrumentKey, {
            interval: "days",
            unit: "1",
        }).catch(() => []);
        const dailyWithLive = mergeLivePriceIntoLatestCandle(dailyCandles, live.ltp);
        const ema20 = calculateEMA(dailyWithLive, 20, instrumentKey);
        const rsiFields = await computeAllRsiFields(instrumentKey);

        const previousSnapshot = indicatorSnapshot.get(instrumentKey) || {};
        const nextSnapshot = {
            ...previousSnapshot,
            symbol: stock.symbol,
            name: stock.name || previousSnapshot.name || "",
            ema20,
            ...rsiFields,
        };

        indicatorSnapshot.set(instrumentKey, nextSnapshot);
        emitMarketTick(live, nextSnapshot);
        return nextSnapshot;
    })()
        .catch((error) => {
            console.log(
                `Realtime RSI refresh failed for ${instrumentKey}:`,
                error.message,
            );
            return indicatorSnapshot.get(instrumentKey) || {};
        })
        .finally(() => {
            realtimeIndicatorInFlight.delete(instrumentKey);
        });

    realtimeIndicatorInFlight.set(instrumentKey, task);
    return task;
}

function scheduleRealtimeIndicatorRefresh(instrumentKey) {
    if (!instrumentKey) return;

    const existingTimer = pendingRealtimeIndicatorTimers.get(instrumentKey);
    if (existingTimer) {
        clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
        pendingRealtimeIndicatorTimers.delete(instrumentKey);
        refreshRealtimeIndicatorsForKey(instrumentKey);
    }, TICK_INDICATOR_DEBOUNCE_MS);

    pendingRealtimeIndicatorTimers.set(instrumentKey, timer);
}

function startIndicatorRefreshLoop() {
    if (indicatorTimer) return;

    indicatorTimer = setInterval(async () => {
        const keys = [...subscribedInstruments];
        if (!keys.length) return;

        await mapWithLimit(keys, 3, async (instrumentKey) => {
            try {
                await refreshIndicatorsForKey(instrumentKey);
            } catch (error) {
                console.log(
                    `Indicator refresh failed for ${instrumentKey}:`,
                    error.message,
                );
            }
        });
    }, INDICATOR_REFRESH_MS);
}

async function mapWithLimit(items = [], limit, worker) {
    if (!Array.isArray(items) || items.length === 0) {
        return [];
    }

    const results = new Array(items.length);
    let cursor = 0;

    async function runner() {
        while (true) {
            const index = cursor++;
            if (index >= items.length) break;
            results[index] = await worker(items[index], index);
        }
    }

    const workerCount = Math.min(limit, items.length);
    await Promise.all(Array.from({ length: workerCount }, () => runner()));

    return results;
}

function pickIndicatorSnapshot(row = {}) {
    return {
        symbol: row.symbol,
        name: row.name,
        ema20: row.ema20,
        rsi: row.rsi,
        prevRsi: row.prevRsi,
        rsiChange: row.rsiChange,
        rsi5m: row.rsi5m,
        prevRsi5m: row.prevRsi5m,
        rsi5mChange: row.rsi5mChange,
        rsi15m: row.rsi15m,
        prevRsi15m: row.prevRsi15m,
        rsi15mChange: row.rsi15mChange,
        hourlyRsi: row.hourlyRsi,
        prevHourlyRsi: row.prevHourlyRsi,
        hourlyRsiChange: row.hourlyRsiChange,
        pe: row.pe,
    };
}

async function buildRow(stock, options = {}) {
    const { includePe = false } = options;
    const instrumentKey = stock.instrumentKey;

    if (!instrumentKey) {
        return {
            symbol: stock.symbol,
            name: stock.name || stock.longName || stock.symbol,
            instrumentKey: null,
            exchange: stock.exchange || stock.market || "",
            market: stock.exchange || stock.market || "",
            instrumentType:
                stock.instrumentType || stock.assetType || stock.type || "",
            assetType: stock.instrumentType || stock.assetType || stock.type || "",
            ltp: null,
            price: null,
            changePercent: 0,
            change: 0,
            volume: 0,
            timestamp: null,
            ema20: null,
            rsi: null,
            prevRsi: null,
            rsiChange: null,
            pe: stock.trailingPE ?? null,
        };
    }

    const live = liveData.get(instrumentKey) || {};
    const dailyCandles = await getCandles(instrumentKey, {
        interval: "days",
        unit: "1",
    }).catch(() => []);
    const lastCandle = dailyCandles[dailyCandles.length - 1];
    const [rsiFields, ema20] = await Promise.all([
        computeAllRsiFields(instrumentKey),
        Promise.resolve(calculateEMA(dailyCandles, 20, instrumentKey)),
    ]);
    const volume =
        live.volume ??
        (lastCandle?.volume != null ? Number(lastCandle.volume) : null);

    let pe = getCachedPe(instrumentKey);
    if (pe == null && includePe) {
        pe = await getPeForInstrument(
            instrumentKey,
            stock.instrumentType || stock.assetType || stock.type,
        );
    }
    if (pe == null) {
        pe = stock.trailingPE ?? null;
    }

    const row = {
        symbol: stock.symbol,
        name: stock.name || stock.longName || stock.symbol,
        instrumentKey,
        exchange: stock.exchange || "",
        market: stock.exchange || stock.market || "",
        instrumentType: stock.instrumentType || stock.assetType || stock.type || "",
        assetType: stock.instrumentType || stock.assetType || stock.type || "",
        ltp: isValidLtp(live.ltp) ? live.ltp : null,
        price: isValidLtp(live.ltp) ? live.ltp : null,
        changeAmount: isValidLtp(live.ltp) ? live.changeAmount ?? 0 : 0,
        changePercent: isValidLtp(live.ltp) ? live.changePercent ?? 0 : 0,
        change: isValidLtp(live.ltp) ? live.changePercent ?? 0 : 0,
        volume: volume ?? 0,
        timestamp: live.timestamp || null,
        ema20,
        ...rsiFields,
        pe,
    };

    indicatorSnapshot.set(instrumentKey, pickIndicatorSnapshot(row));

    return row;
}

function applyLivePriceToRow(row) {
    if (!row?.instrumentKey) return row;

    const live = liveData.get(row.instrumentKey);
    if (!live || !isValidLtp(live.ltp)) return row;

    return {
        ...row,
        ltp: live.ltp,
        price: live.ltp,
        changeAmount: live.changeAmount ?? row.changeAmount ?? 0,
        changePercent: live.changePercent ?? row.changePercent ?? 0,
        change: live.changePercent ?? row.change ?? 0,
        volume:
            live.volume != null && live.volume > 0 ? live.volume : row.volume,
        timestamp: live.timestamp || row.timestamp,
    };
}

function broadcastLivePrices(keys = []) {
    keys.forEach((instrumentKey) => {
        const live = liveData.get(instrumentKey);
        if (!live || !isValidLtp(live.ltp)) return;
        emitMarketTick(
            { ...live, instrumentKey },
            indicatorSnapshot.get(instrumentKey) || {},
        );
    });
}

function startLtpPollLoop() {
    if (ltpPollTimer) return;

    ltpPollTimer = setInterval(async () => {
        const keys = [...subscribedInstruments];
        if (!keys.length) return;

        // REST LTP is fallback when socket is down; socket is primary for live rates.
        if (socketConnected && ws?.readyState === WebSocket.OPEN) {
            return;
        }

        await warmLiveQuotes(keys);
        broadcastLivePrices(keys);
    }, LTP_POLL_MS);
}

async function warmLiveQuotes(instrumentKeys = []) {
    const token = getAccessToken();
    const uniqueKeys = [...new Set(instrumentKeys.filter(Boolean))];
    if (!token || !uniqueKeys.length) return;

    const chunkSize = 50;

    for (let i = 0; i < uniqueKeys.length; i += chunkSize) {
        const chunk = uniqueKeys.slice(i, i + chunkSize);
        const query = chunk.map((key) => encodeURIComponent(key)).join(",");

        try {
            const response = await axios.get(
                `https://api.upstox.com/v3/market-quote/ltp?instrument_key=${query}`,
                {
                    headers: {
                        Accept: "application/json",
                        Authorization: `Bearer ${token}`,
                    },
                    timeout: 15000,
                },
            );

            const quotes = response.data?.data || {};

            Object.values(quotes).forEach((quote) => {
                const instrumentKey = quote.instrument_token;
                if (!instrumentKey) return;

                const ltp = toNum(quote.last_price ?? quote.ltp);
                const cp = toNum(quote.cp);
                if (!isValidLtp(ltp)) return;

                const previous = liveData.get(instrumentKey) || {};
                liveData.set(instrumentKey, {
                    ...previous,
                    instrumentKey,
                    ltp,
                    changeAmount: cp ? Number((ltp - cp).toFixed(2)) : 0,
                    changePercent:
                        cp && ltp
                            ? Number((((ltp - cp) / cp) * 100).toFixed(2))
                            : 0,
                    volume:
                        toNum(quote.volume) > 0
                            ? toNum(quote.volume)
                            : previous.volume,
                    timestamp: Date.now(),
                });
            });
        } catch (error) {
            console.log("Upstox LTP warm failed:", error.message);
        }
    }
}

async function getRowsForWatchlist(watchlist) {
    const stocks = watchlist.stocks || [];
    const keys = stocks.map((stock) => stock.instrumentKey).filter(Boolean);

    await loadInstruments().catch(() => []);
    await warmLiveQuotes(keys);
    subscribe(keys);
    warmCandles(keys).catch((error) =>
        console.log("Upstox candle warm failed:", error.message),
    );
    warmPeForInstruments(stocks).catch((error) =>
        console.log("Upstox PE warm failed:", error.message),
    );

    const rows = (await mapWithLimit(stocks, 5, (stock) => buildRow(stock))).map(
        applyLivePriceToRow,
    );

    broadcastLivePrices(keys);

    return {
        data: rows,
        total: rows.length,
        updatedAt: new Date(),
        marketStatus: {
            label: socketConnected
                ? "Upstox Live (WebSocket)"
                : subscribedInstruments.size
                  ? "Upstox Live (REST)"
                  : "Waiting for instruments",
        },
    };
}

function subscribe(instrumentKeys = []) {
    const next = new Set(instrumentKeys.filter(Boolean));
    const toSubscribe = [...next].filter((key) => !subscribedInstruments.has(key));
    const toUnsubscribe = [...subscribedInstruments].filter((key) => !next.has(key));

    toSubscribe.forEach((key) => subscribedInstruments.add(key));
    toUnsubscribe.forEach((key) => subscribedInstruments.delete(key));

    connectFeed();
    sendSubscription(toSubscribe, "sub");
    sendSubscription(toUnsubscribe, "unsub");
}

function init(socketIo) {
    io = socketIo;
    loadInstruments().catch((error) =>
        console.log("Upstox instrument master load failed:", error.message),
    );
    startIndicatorRefreshLoop();
    startLtpPollLoop();
    connectFeed();
}

module.exports = {
    init,
    liveData,
    subscribedInstruments,
    searchInstruments,
    getRowsForWatchlist,
    subscribe,
};
