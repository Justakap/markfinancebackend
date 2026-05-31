const express = require("express");
const cors = require("cors");
require("dotenv").config();

const Stock = require("./models/Stock");
const Watchlist = require("./models/Watchlist");
const User = require("./models/User");
const Strategy = require("./models/Strategy");
const Backtest = require("./models/Backtest");
const jwt = require("jsonwebtoken");
const evaluator = require("./utils/strategyEvaluator");
const { requireAuth } = require("./middleware/auth");
const { getJwtSecret } = require("./config/jwt");
const { connectDatabase, isDatabaseConnected } = require("./config/database");
const { requireDatabase } = require("./middleware/dbReady");
const {
    deleteCache,
    fetchQuote,
    fetchQuoteSummary,
    searchSymbols,
} = require("./utils/yahooClient");
const {
    runBacktestSimulation,
    fetchBacktestCandles,
    getStrategyInterval,
    resolveBacktestConfig,
    INTERVAL_CONFIG,
} = require("./utils/backtestEngine");
const { runIndicatorValidation } = require("./utils/validationService");
const { ensureYahooSymbol } = require("./utils/symbols");
const marketEngine = require("./services/marketEngine");
const marketCache = require("./services/marketCache");
const { getMetrics, recordScanTime, recordBacktestTime } = require("./utils/metrics");
const http = require("http");
const { Server } = require("socket.io");

const VALIDATION_MODE =
    process.env.ENABLE_VALIDATION_MODE === "true" ||
    process.env.NODE_ENV !== "production";

function ownsResource(ownerId, req) {
    return String(ownerId) === String(req.user.mongoId);
}

try {
    getJwtSecret();
} catch (error) {
    console.error(error.message);
    process.exit(1);
}

const app = express();

app.use(cors());
app.use(express.json());

// Simple rate limiter per IP (very basic)
const rateMap = new Map();
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

app.get("/", (req, res) => {
    res.send("Share Analysis MK API Running");
});

app.get("/api/health", (req, res) => {
    res.json({
        ok: true,
        database: isDatabaseConnected() ? "connected" : "disconnected",
    });
});

app.use("/api", requireDatabase);

//market mapper


function getMarket(exchange) {
    switch (exchange) {
        case "NSI":
            return "NSE";

        case "BSE":
            return "BSE";

        case "NMS":
            return "NASDAQ";

        case "NYQ":
            return "NYSE";

        case "DJI":
            return "DOW JONES";

        case "CCY":
        case "CCC":
            return "CRYPTO";

        default:
            return exchange || "UNKNOWN";
    }
}


// use unified evaluator for condition and strategy evaluation
const { evaluateStrategy } = evaluator;

function buildPreviousFromCurrent(current) {
    return {
        price: current.prevPrice ?? null,
        change: null,
        volume: null,
        pe: null,

        rsi: current.prevRsi ?? null,
        hourlyRsi: current.prevHourlyRsi ?? null,
        rsi15m: current.prevRsi15m ?? null,
        rsi5m: current.prevRsi5m ?? null,
        rsi1m: current.prevRsi1m ?? null,

        ema20: current.prevEma20 ?? null,
        ema50: current.prevEma50 ?? null,
        ema200: current.prevEma200 ?? null,

        sma20: current.prevSma20 ?? null,
        sma50: current.prevSma50 ?? null,

        volumeChange: null,
        high52Pct: null,
        low52Pct: null,
    };
}


// run strategy

app.post(
    "/api/strategies/run",
    requireAuth,
    async (req, res) => {
        if (!rateLimit(req.ip, 8, 60)) return res.status(429).json({ message: "Too many requests" });
        try {
            const {
                strategyId,
                watchlistId,
            } = req.body;

            const strategy =
                await Strategy.findById(
                    strategyId
                );

            const watchlist =
                await Watchlist.findById(
                    watchlistId
                );

            if (!strategy) {
                return res.status(404).json({
                    message:
                        "Strategy not found",
                });
            }

            if (!watchlist) {
                return res.status(404).json({
                    message:
                        "Watchlist not found",
                });
            }

            if (strategy.userId && !ownsResource(strategy.userId, req)) {
                return res.status(403).json({ message: "Forbidden" });
            }

            if (watchlist.userId && !ownsResource(watchlist.userId, req)) {
                return res.status(403).json({ message: "Forbidden" });
            }

            const stocks = watchlist.stocks.map((stock) => ({
                symbol: stock.symbol,
                yahooSymbol: ensureYahooSymbol(stock.symbol, stock.market),
                name: stock.name,
                market: stock.market || "",
                displaySymbol: stock.symbol,
            }));

            marketEngine.trackSymbols(stocks);

            const scanStart = Date.now();
            const { rows: marketData } = marketEngine.getScanData(stocks);
            recordScanTime(Date.now() - scanStart);

            if (!marketData.length) {
                await marketEngine.warmMissing(
                    stocks.slice(0, 10).map((s) => ({
                        yahooSymbol: s.yahooSymbol,
                        displaySymbol: s.symbol,
                        name: s.name,
                        market: s.market || "",
                    })),
                );
            }

            const cachedRows = marketEngine.getScanData(stocks).rows;

            const conditions =
                strategy.entryConditions?.length
                    ? strategy.entryConditions
                    : strategy.conditions ||
                    [];

            const matches = cachedRows.filter((stock) => {
                const previous = buildPreviousFromCurrent(stock);

                return evaluateStrategy(stock, previous, conditions, strategy.logic || "AND");
            });

            return res.json({
                strategy:
                    strategy.name,
                matched:
                    matches.length,
                matches,
                scanTimeMs: Date.now() - scanStart,
                cacheOnly: true,
            });
        } catch (error) {
            console.log(error);

            return res.status(500).json({
                message:
                    "Failed to run strategy",
            });
        }
    }
);







app.get("/api/debug/:symbol", async (req, res) => {
    try {
        const yahooSymbol = ensureYahooSymbol(req.params.symbol);
        await marketEngine.refreshSymbol(yahooSymbol);
        const data = marketCache.get(yahooSymbol) || {};

        res.json({
            availableIndicators: {
                Price: data.price,
                "Price Change %": data.change,
                Volume: data.volume,
                "Volume Change %": data.volumeChange,
                "PE Ratio": data.pe,
                "RSI (Daily)": data.rsi,
                "RSI (1 Hour)": data.hourlyRsi,
                "RSI (15 Minute)": data.rsi15m,
                "RSI (5 Minute)": data.rsi5m,
                "RSI (1 Minute)": data.rsi1m,
                EMA20: data.ema20,
                EMA50: data.ema50,
                EMA200: data.ema200,
            },
            rawData: data,
            note: "RSI uses Wilder's smoothing (TradingView compatible). EMA uses standard formula.",
        });
    } catch (error) {
        res.status(500).json({
            message: error.message,
        });
    }
});

app.get("/api/validation/indicators", async (req, res) => {
    if (!VALIDATION_MODE) {
        return res.status(403).json({ message: "Validation mode disabled" });
    }

    try {
        const report = await runIndicatorValidation();
        res.json(report);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

app.get("/api/validation/debug/:symbol", async (req, res) => {
    if (!VALIDATION_MODE) {
        return res.status(403).json({ message: "Validation mode disabled" });
    }

    try {
        const yahooSymbol = ensureYahooSymbol(req.params.symbol);
        await marketEngine.refreshSymbol(yahooSymbol);
        const data = marketCache.get(yahooSymbol) || {};
        res.json({ symbol: req.params.symbol, rawData: data });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});


// google login 



app.post("/api/auth/google", async (req, res) => {
    try {
        const { uid, name, email, photoURL } = req.body;

        if (!uid || !email) {
            return res.status(400).json({
                success: false,
                message: "Google uid and email are required",
            });
        }

        let user = await User.findOne({
            $or: [
                { googleId: uid },
                { email },
            ],
        });

        let isNewUser = false;

        if (!user) {
            user = await User.create({
                googleId: uid,
                name,
                email,
                profilePic: photoURL || "",
            });

            isNewUser = true;
        } else {
            user.googleId = user.googleId || uid;
            user.name = name || user.name;
            user.email = email || user.email;
            user.profilePic = photoURL || user.profilePic || "";

            await user.save();
        }

        if (isNewUser) {
            const existingWatchlist = await Watchlist.findOne({
                userId: user._id,
            });

            if (!existingWatchlist) {
                await Watchlist.create({
                    name: "My Watchlist",
                    userId: user._id,
                    stocks: [],
                });
            }
        }

        const token = jwt.sign(
            {
                mongoId: String(user._id),
                name: user.name,
                email: user.email,
            },
            getJwtSecret(),
            { expiresIn: "7d" },
        );

        res.json({
            success: true,
            user,
            token,
        });
    } catch (error) {
        console.log(error);

        res.status(500).json({
            success: false,
            message: error.message,
        });
    }
});


app.get("/test", async (req, res) => {
    try {
        const quote = await fetchQuote("TCS.NS");

        console.log(quote);

        res.json(quote);
    } catch (error) {
        console.log(error);

        res.status(500).json({
            message: error.message,
        });
    }
});




// =======================
// Market Data
// =======================

app.get("/api/market-data/:watchlistId", requireAuth, async (req, res) => {
    const start = Date.now();

    try {
        const watchlist = await Watchlist.findById(req.params.watchlistId);
        if (!watchlist) return res.status(404).json({ message: "Watchlist not found" });

        if (watchlist.userId && !ownsResource(watchlist.userId, req)) {
            return res.status(403).json({ message: "Forbidden" });
        }

        if (!watchlist.stocks?.length) {
            return res.json({ data: [], total: 0, offset: 0, limit: 0, fromCache: true });
        }

        const offset = Math.max(0, parseInt(req.query.offset || "0", 10));
        const limit = Math.max(1, parseInt(req.query.limit || "50", 10));

        const stocks = watchlist.stocks.map((stock) => ({
            symbol: stock.symbol,
            yahooSymbol: ensureYahooSymbol(stock.symbol, stock.market),
            name: stock.name,
            market: stock.market || "",
            displaySymbol: stock.symbol,
        }));

        marketEngine.trackWatchlist(watchlist._id.toString(), stocks);

        let result = marketEngine.getWatchlistFromCache(stocks, { offset, limit });

        const allMissing = stocks.filter(
            (s) => !marketCache.has(s.yahooSymbol),
        );

        if (allMissing.length > 0 && watchlist.stocks.length <= 80) {
            await marketEngine.warmQuotesFast(allMissing, 6);
            result = marketEngine.getWatchlistFromCache(stocks, { offset, limit });

            setImmediate(() => {
                marketEngine
                    .warmIndicators(allMissing, 3)
                    .catch((err) => console.log("Indicator warm:", err.message));
            });
        } else if (result.missing > 0) {
            const chunk = stocks.slice(offset, offset + limit);
            setImmediate(() => {
                marketEngine
                    .warmMissing(chunk)
                    .catch((err) => console.log("Warm missing:", err.message));
            });
        }

        res.json({
            data: result.data,
            total: result.total,
            offset: result.offset,
            limit: result.limit,
            fromCache: true,
            marketStatus: result.marketStatus,
            updatedAt: result.updatedAt,
            responseTimeMs: Date.now() - start,
        });
    } catch (error) {
        console.log("Market data error:", error);
        res.status(500).json({
            message: error.message || "Failed to load market data",
        });
    }
});


// Stratergy 

app.post("/api/strategies", requireAuth, async (req, res) => {
    try {
        const {
            name,
            description,

            entryConditions,
            exitConditions,

            stopLoss,
            target,

            logic,
            alertEnabled,
        } = req.body;

        if (!name || !name.trim()) return res.status(400).json({ message: "Strategy name required" });

        const strategy = await Strategy.create({
            userId: req.user.mongoId,
            name,
            description,

            entryConditions,
            exitConditions,

            stopLoss,
            target,

            logic,
            alertEnabled,
        });

        res.status(201).json(strategy);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Failed to create strategy" });
    }
});

app.get("/api/strategies/:userId", requireAuth, async (req, res) => {
    try {
        if (req.user.mongoId !== req.params.userId) return res.status(403).json({ message: "Forbidden" });

        const strategies = await Strategy.find({ userId: req.params.userId }).sort({ createdAt: -1 });

        res.json(strategies);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Failed to fetch strategies" });
    }
});



app.put("/api/strategies/:id", requireAuth, async (req, res) => {
    try {
        const strategy = await Strategy.findById(req.params.id);
        if (!strategy) return res.status(404).json({ message: "Strategy not found" });
        if (strategy.userId.toString() !== req.user.mongoId) return res.status(403).json({ message: "Forbidden" });

        const updated = await Strategy.findByIdAndUpdate(req.params.id, req.body, { new: true });
        res.json(updated);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Failed to update strategy" });
    }
});


app.delete("/api/strategies/:id", requireAuth, async (req, res) => {
    try {
        const strategy = await Strategy.findById(req.params.id);
        if (!strategy) return res.status(404).json({ message: "Strategy not found" });
        if (strategy.userId.toString() !== req.user.mongoId) return res.status(403).json({ message: "Forbidden" });

        await Strategy.findByIdAndDelete(req.params.id);

        res.json({ success: true, message: "Strategy deleted" });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Failed to delete strategy" });
    }
});







// =======================
// Seed Stocks
// =======================

app.post("/api/seed-stocks", async (req, res) => {
    try {

        await Stock.insertMany([
            {
                symbol: "TCS.NS",
                name: "Tata Consultancy Services",
                exchange: "NSE"
            },
            {
                symbol: "INFY.NS",
                name: "Infosys",
                exchange: "NSE"
            },
            {
                symbol: "RELIANCE.NS",
                name: "Reliance Industries",
                exchange: "NSE"
            },
            {
                symbol: "HDFCBANK.NS",
                name: "HDFC Bank",
                exchange: "NSE"
            },
            {
                symbol: "SBIN.NS",
                name: "State Bank of India",
                exchange: "NSE"
            }
        ]);

        res.json({
            message: "Stocks Seeded"
        });

    } catch (error) {
        res.status(500).json({
            message: error.message
        });
    }
});






app.post("/api/watchlists/:id/refresh-fundamentals", requireAuth, async (req, res) => {
    try {
        const watchlist = await Watchlist.findById(req.params.id);

        if (!watchlist) return res.status(404).json({ message: "Watchlist not found" });
        if (watchlist.userId && watchlist.userId.toString() !== req.user.mongoId) return res.status(403).json({ message: "Forbidden" });

        for (const stock of watchlist.stocks) {
            try {
                const quote = await fetchQuote(stock.symbol);

                const summary = await fetchQuoteSummary(stock.symbol, [
                    "assetProfile",
                ]);

                const profile = summary.assetProfile || {};

                stock.longName = quote.longName || stock.longName;

                stock.sector = profile.sector || "";
                stock.industry = profile.industry || "";

                stock.website = profile.website || "";

                stock.country = profile.country || "";
                stock.city = profile.city || "";

                stock.fullTimeEmployees =
                    profile.fullTimeEmployees || 0;

                stock.longBusinessSummary =
                    profile.longBusinessSummary || "";

                stock.updatedAt = new Date();
            } catch (err) {
                console.log(
                    "Failed:",
                    stock.symbol
                );
            }
        }

        await watchlist.save();

        res.json({
            message: "Fundamentals refreshed",
        });
    } catch (error) {
        console.log(error);

        res.status(500).json({
            message: "Server Error",
        });
    }
});







// =======================
// Search Stock
// =======================

app.get("/api/search-stock", async (req, res) => {
    if (!rateLimit(req.ip, 10, 60)) return res.status(429).json({ message: "Too many requests" });
    try {
        const q = req.query.q;

        if (!q) {
            return res.json([]);
        }

        const result = await searchSymbols(q);

        const stocks = result.quotes
            .filter(
                (item) =>
                    item.symbol &&
                    (item.shortname || item.longname)
            )
            .slice(0, 20)
            .map((item) => ({
                symbol: item.symbol,
                name: item.shortname,
                exchange: item.exchange,
                market: getMarket(item.exchange),
                assetType: item.quoteType,
            }));

        res.json(stocks);

    } catch (error) {
        console.log(error);

        res.status(500).json({
            message: "Search failed",
        });
    }
});


// =======================
// Create Watchlist
// =======================

app.post("/api/watchlists", requireAuth, async (req, res) => {
    try {
        const { name } = req.body;
        if (!name || !name.trim()) return res.status(400).json({ message: "Watchlist name required" });

        const watchlist = await Watchlist.create({ name: name.trim(), userId: req.user.mongoId, stocks: [] });

        res.status(201).json(watchlist);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

// =======================
// Get All Watchlists
// =======================
app.get("/api/watchlists", requireAuth, async (req, res) => {
    try {
        const { userId } = req.query;
        if (!userId) return res.json([]);
        if (req.user.mongoId !== userId) return res.status(403).json({ message: "Forbidden" });

        const watchlists = await Watchlist.find({ userId }).sort({ createdAt: -1 });
        res.json(watchlists);
    } catch (error) {
        console.log("WATCHLIST ERROR:");
        console.log(error);
        res.status(500).json({ message: error.message });
    }
});

// =======================
// Get Single Watchlist
// =======================

app.get("/api/watchlists/:id", requireAuth, async (req, res) => {
    try {
        const watchlist = await Watchlist.findById(req.params.id);
        if (!watchlist) return res.status(404).json({ message: "Watchlist not found" });
        if (watchlist.userId && watchlist.userId.toString() !== req.user.mongoId) return res.status(403).json({ message: "Forbidden" });
        res.json(watchlist);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});


// =======================
// Rename Watchlist
// =======================

app.put("/api/watchlists/:id", requireAuth, async (req, res) => {
    try {
        const { name } = req.body;
        if (!name || !name.trim()) return res.status(400).json({ message: "Watchlist name required" });

        const watchlist = await Watchlist.findById(req.params.id);
        if (!watchlist) return res.status(404).json({ message: "Watchlist not found" });
        if (watchlist.userId && watchlist.userId.toString() !== req.user.mongoId) return res.status(403).json({ message: "Forbidden" });

        watchlist.name = name.trim();
        await watchlist.save();

        res.json(watchlist);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});


// =======================
// Delete Watchlist
// =======================

app.delete("/api/watchlists/:id", requireAuth, async (req, res) => {
    try {
        const watchlist = await Watchlist.findById(req.params.id);
        if (!watchlist) return res.status(404).json({ message: "Watchlist not found" });
        if (watchlist.userId && watchlist.userId.toString() !== req.user.mongoId) return res.status(403).json({ message: "Forbidden" });

        await Watchlist.findByIdAndDelete(req.params.id);

        res.json({ message: "Watchlist deleted" });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});


// =======================
// Add Stock To Watchlist
// =======================

app.post("/api/watchlists/:id/stocks", requireAuth, async (req, res) => {
    try {
        const { symbol, name, exchange, market, assetType } = req.body;
        const quote = await fetchQuote(symbol);

        let profile = {};
        try {
            const summary = await fetchQuoteSummary(symbol, ["assetProfile"]);
            profile = summary.assetProfile || {};
        } catch (error) {
            console.log("Asset Profile Error:", symbol);
        }

        const watchlist = await Watchlist.findById(req.params.id);
        if (!watchlist) return res.status(404).json({ message: "Watchlist not found" });
        if (watchlist.userId && watchlist.userId.toString() !== req.user.mongoId) return res.status(403).json({ message: "Forbidden" });

        const exists = watchlist.stocks.find((stock) => stock.symbol === symbol);
        if (!exists) {
            watchlist.stocks.push({
                symbol,
                name,
                longName: quote.longName || "",
                exchange,
                market,
                assetType,
                sector: profile.sector || "",
                industry: profile.industry || "",
                marketCap: quote.marketCap || 0,
                sharesOutstanding: quote.sharesOutstanding || 0,
                trailingPE: quote.trailingPE || 0,
                forwardPE: quote.forwardPE || 0,
                priceToBook: quote.priceToBook || 0,
                bookValue: quote.bookValue || 0,
                epsTrailingTwelveMonths: quote.epsTrailingTwelveMonths || 0,
                epsForward: quote.epsForward || 0,
                dividendYield: quote.dividendYield || 0,
                dividendRate: quote.dividendRate || 0,
                fiftyTwoWeekHigh: quote.fiftyTwoWeekHigh || 0,
                fiftyTwoWeekLow: quote.fiftyTwoWeekLow || 0,
                averageAnalystRating: quote.averageAnalystRating || "",
                averageDailyVolume3Month: quote.averageDailyVolume3Month || 0,
                averageDailyVolume10Day: quote.averageDailyVolume10Day || 0,
                beta: quote.beta || 0,
                currency: quote.currency || "",
                website: profile.website || "",
                country: profile.country || "",
                city: profile.city || "",
                fullTimeEmployees: profile.fullTimeEmployees || 0,
                longBusinessSummary: profile.longBusinessSummary || "",
                updatedAt: new Date(),
            });

            await watchlist.save();
            deleteCache(`market:${watchlist._id}`);
            marketEngine.trackSymbols(
                watchlist.stocks.map((s) => ({
                    symbol: s.symbol,
                    yahooSymbol: ensureYahooSymbol(s.symbol, s.market),
                    market: s.market || "",
                    displaySymbol: s.symbol,
                    name: s.name,
                })),
            );
        }

        res.json(watchlist);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});


// =======================
// Remove Stock From Watchlist
// =======================

app.delete("/api/watchlists/:id/stocks/:symbol", requireAuth, async (req, res) => {
    try {
        const watchlist = await Watchlist.findById(req.params.id);
        if (!watchlist) return res.status(404).json({ message: "Watchlist not found" });
        if (watchlist.userId && watchlist.userId.toString() !== req.user.mongoId) {
            return res.status(403).json({ message: "Forbidden" });
        }

        const symbol = decodeURIComponent(req.params.symbol);

        const updated = await Watchlist.findByIdAndUpdate(
            req.params.id,
            { $pull: { stocks: { symbol } } },
            { new: true },
        );

        deleteCache(`market:${watchlist._id}`);

        res.json(updated);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

app.post("/api/watchlists/:id/stocks/bulk-remove", requireAuth, async (req, res) => {
    try {
        const { symbols = [] } = req.body;

        if (!Array.isArray(symbols) || !symbols.length) {
            return res.status(400).json({ message: "symbols array required" });
        }

        const watchlist = await Watchlist.findById(req.params.id);
        if (!watchlist) return res.status(404).json({ message: "Watchlist not found" });
        if (watchlist.userId && watchlist.userId.toString() !== req.user.mongoId) {
            return res.status(403).json({ message: "Forbidden" });
        }

        const updated = await Watchlist.findByIdAndUpdate(
            req.params.id,
            { $pull: { stocks: { symbol: { $in: symbols } } } },
            { new: true },
        );

        deleteCache(`market:${watchlist._id}`);

        res.json(updated);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});



app.get("/api/strategy-details/:id", requireAuth, async (req, res) => {
    try {
        const strategy = await Strategy.findById(req.params.id);

        if (!strategy) {
            return res.status(404).json({
                message: "Strategy not found",
            });
        }

        if (strategy.userId && !ownsResource(strategy.userId, req)) {
            return res.status(403).json({ message: "Forbidden" });
        }

        res.json({
            ...strategy.toObject(),
            backtestInterval: getStrategyInterval(strategy),
            intervalLimits: INTERVAL_CONFIG,
            backtestPreview: resolveBacktestConfig(strategy, "1y"),
        });
    } catch (error) {
        console.log(error);

        res.status(500).json({
            message: "Failed to fetch strategy",
        });
    }
});

app.post("/api/backtest/run", requireAuth, async (req, res) => {
    const btStart = Date.now();

    try {
        const {
            strategyId,
            symbol,
            period,
            capital = 10000,
            validationMode = false,
        } = req.body;

        if (!symbol) return res.status(400).json({ message: "Symbol required" });

        const strategy = await Strategy.findById(strategyId);
        if (!strategy) return res.status(404).json({ message: "Strategy not found" });

        if (strategy.userId && !ownsResource(strategy.userId, req)) {
            return res.status(403).json({ message: "Forbidden" });
        }

        const yahooSymbol = ensureYahooSymbol(symbol);
        const { candles, auxiliaryCandles, config: backtestConfig } =
            await fetchBacktestCandles(yahooSymbol, period, strategy);

        if (!candles.length) {
            return res.status(400).json({
                message: `No price history found for ${yahooSymbol}. Use symbols like INFY.NS or TCS.NS.`,
            });
        }

        const simulation = runBacktestSimulation({
            strategy,
            candles,
            capital,
            interval: backtestConfig.interval,
            auxiliaryCandles,
            validationMode:
                validationMode && VALIDATION_MODE,
        });

        const {
            summary,
            trades,
            equityCurve,
            signalStats,
            tradeMarkers,
            auditLog,
            signalLogs,
        } = simulation;

        const backtestMeta = {
            interval: backtestConfig.interval,
            intervalLabel: backtestConfig.label,
            requestedPeriod: period,
            effectiveDays: backtestConfig.effectiveDays,
            capped: backtestConfig.capped,
            message: backtestConfig.message,
            candleCount: candles.length,
            requiredIntervals: backtestConfig.requiredIntervals,
        };

        try {
            const userId = req.user?.mongoId;
            if (userId) {
                await Backtest.create({
                    userId,
                    strategyId,
                    symbol,
                    period,
                    capital,
                    metrics: summary,
                    trades,
                    equityCurve,
                });
            }
        } catch (err) {
            console.log("Failed to save backtest:", err);
        }

        recordBacktestTime(Date.now() - btStart);

        res.json({
            strategy: strategy.name,
            summary,
            trades,
            equityCurve,
            tradeMarkers,
            signalStats,
            auditLog: validationMode && VALIDATION_MODE ? auditLog : undefined,
            signalLogs:
                validationMode && VALIDATION_MODE ? signalLogs : undefined,
            backtestMeta,
            backtestTimeMs: Date.now() - btStart,
        });
    } catch (error) {
        recordBacktestTime(Date.now() - btStart);
        console.log(error);

        res.status(500).json({
            message: "Backtest failed",
        });
    }
});

app.get("/api/dashboard", requireAuth, async (req, res) => {
    try {
        const userId = req.user.mongoId;

        const watchlists = await Watchlist.find({ userId });
        const stocksTracked = watchlists.reduce(
            (sum, list) => sum + (list.stocks?.length || 0),
            0,
        );

        const strategies = await Strategy.countDocuments({ userId });
        const backtests = await Backtest.countDocuments({ userId });

        const startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);

        const signalsToday = await Strategy.countDocuments({
            userId,
            alertEnabled: true,
        });

        const recentBacktests = await Backtest.find({ userId })
            .sort({ createdAt: -1 })
            .limit(5)
            .populate("strategyId", "name");

        const recentActivity = recentBacktests.map((item) => ({
            type: "backtest",
            title: `Backtest: ${item.symbol}`,
            subtitle: item.strategyId?.name || "Strategy",
            date: item.createdAt,
            meta: {
                profit: item.metrics?.netProfit ?? item.metrics?.totalReturn,
                winRate: item.metrics?.winRate,
            },
        }));

        res.json({
            watchlists: watchlists.length,
            stocksTracked,
            strategies,
            backtests,
            signalsToday,
            recentActivity,
        });
    } catch (error) {
        console.log(error);
        res.status(500).json({ message: "Failed to load dashboard" });
    }
});

app.get("/api/backtests/:userId", requireAuth, async (req, res) => {
    try {
        if (req.user.mongoId !== req.params.userId) {
            return res.status(403).json({ message: "Forbidden" });
        }

        const backtests = await Backtest.find({ userId: req.params.userId })
            .sort({ createdAt: -1 })
            .populate("strategyId", "name");

        res.json(backtests);
    } catch (err) {
        console.log(err);
        res.status(500).json({ message: "Failed to fetch backtests" });
    }
});

app.get("/api/backtests/detail/:id", requireAuth, async (req, res) => {
    try {
        const backtest = await Backtest.findById(req.params.id).populate(
            "strategyId",
            "name",
        );

        if (!backtest) {
            return res.status(404).json({ message: "Backtest not found" });
        }

        if (
            backtest.userId &&
            backtest.userId.toString() !== req.user.mongoId
        ) {
            return res.status(403).json({ message: "Forbidden" });
        }

        res.json(backtest);
    } catch (err) {
        console.log(err);
        res.status(500).json({ message: "Failed to fetch backtest" });
    }
});

app.delete("/api/backtests/:id", requireAuth, async (req, res) => {
    try {
        const backtest = await Backtest.findById(req.params.id);

        if (!backtest) {
            return res.status(404).json({ message: "Backtest not found" });
        }

        if (
            backtest.userId &&
            backtest.userId.toString() !== req.user.mongoId
        ) {
            return res.status(403).json({ message: "Forbidden" });
        }

        await Backtest.findByIdAndDelete(req.params.id);

        res.json({ success: true });
    } catch (err) {
        console.log(err);
        res.status(500).json({ message: "Failed to delete backtest" });
    }
});


app.get("/api/metrics", requireAuth, async (req, res) => {
    try {
        res.json({
            ...getMetrics(),
            marketStatus: marketEngine.getMarketStatus(),
            cacheSize: marketCache.size(),
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});


const PORT = process.env.PORT || 5001;

async function startServer() {
    try {
        await connectDatabase();
    } catch (error) {
        console.error("MongoDB connection failed:", error.message);
        console.error(
            "Tips: verify MONGO_URI in backend/.env, start local MongoDB, or allow your IP in MongoDB Atlas.",
        );
        process.exit(1);
    }

    const server = http.createServer(app);
    const io = new Server(server, {
        cors: {
            origin: process.env.FRONTEND_URL || "*",
            methods: ["GET", "POST"],
        },
    });

    marketEngine.init(io);

    server.listen(PORT, () => {
        console.log(`Server running on port ${PORT} (Socket.IO enabled)`);
    });
}

startServer();
