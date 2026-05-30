const YahooFinance = require("yahoo-finance2").default;
const { RSI, EMA, SMA } = require("technicalindicators");
const yahooFinance = new YahooFinance();
const express = require("express");
const mongoose = require("mongoose");
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

const app = express();

app.use(cors());
app.use(express.json());

// Simple in-memory cache with TTL
const cache = new Map();
function setCache(key, value, ttl = 30) {
    const expires = Date.now() + ttl * 1000;
    cache.set(key, { value, expires });
}
function getCache(key) {
    const item = cache.get(key);
    if (!item) return null;
    if (Date.now() > item.expires) {
        cache.delete(key);
        return null;
    }
    return item.value;
}

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

mongoose
    .connect(process.env.MONGO_URI)
    .then(() => console.log("MongoDB Connected"))
    .catch((err) => console.log(err));

app.get("/", (req, res) => {
    res.send("Share Analysis MK API Running");
});

async function getMarketData(symbol) {
    try {
        const quote = await yahooFinance.quote(symbol);

        const calculateRsiData = (values) => {
            if (values.length < 15) {
                return {
                    rsi: null,
                    prev: null,
                    change: null,
                };
            }

            const rsiValues = RSI.calculate({
                period: 14,
                values,
            });

            const rsi =
                rsiValues[rsiValues.length - 1];

            const prev =
                rsiValues[rsiValues.length - 2];

            return {
                rsi,
                prev,
                change:
                    prev !== undefined
                        ? ((rsi - prev) / prev) * 100
                        : null,
            };
        };

        // ======================
        // Daily
        // ======================

        const dailyChart = await yahooFinance.chart(
            symbol,
            {
                period1: new Date(
                    Date.now() -
                    400 * 24 * 60 * 60 * 1000
                ),
                period2: new Date(),
                interval: "1d",
            }
        );

        const volumes = dailyChart.quotes
            .map((q) => q.volume)
            .filter(Boolean);

        let volumeChange = null;

        if (volumes.length >= 20) {
            const avg20 =
                volumes.slice(-20).reduce((a, b) => a + b, 0) /
                20;

            volumeChange =
                ((quote.regularMarketVolume - avg20) /
                    avg20) *
                100;
        }

        const high52Pct =
            quote.fiftyTwoWeekHigh
                ? ((quote.regularMarketPrice -
                    quote.fiftyTwoWeekHigh) /
                    quote.fiftyTwoWeekHigh) *
                100
                : null;


        const low52Pct =
            quote.fiftyTwoWeekLow
                ? ((quote.regularMarketPrice -
                    quote.fiftyTwoWeekLow) /
                    quote.fiftyTwoWeekLow) *
                100
                : null;

        const dailyCloses =
            dailyChart.quotes
                .map((q) => q.close)
                .filter(
                    (close) =>
                        close !== null &&
                        close !== undefined &&
                        !isNaN(close)
                );

        // ======================
        // Hourly
        // ======================

        const hourlyChart =
            await yahooFinance.chart(symbol, {
                period1: new Date(
                    Date.now() -
                    30 * 24 * 60 * 60 * 1000
                ),
                period2: new Date(),
                interval: "1h",
            });

        const hourlyCloses =
            hourlyChart.quotes
                .map((q) => q.close)
                .filter(
                    (close) =>
                        close !== null &&
                        close !== undefined &&
                        !isNaN(close)
                );

        // ======================
        // 15 Min
        // ======================

        const chart15m =
            await yahooFinance.chart(symbol, {
                period1: new Date(
                    Date.now() -
                    15 * 24 * 60 * 60 * 1000
                ),
                period2: new Date(),
                interval: "15m",
            });

        const closes15m =
            chart15m.quotes
                .map((q) => q.close)
                .filter(
                    (close) =>
                        close !== null &&
                        close !== undefined &&
                        !isNaN(close)
                );

        // ======================
        // 5 Min
        // ======================

        const chart5m =
            await yahooFinance.chart(symbol, {
                period1: new Date(
                    Date.now() -
                    10 * 24 * 60 * 60 * 1000
                ),
                period2: new Date(),
                interval: "5m",
            });

        const closes5m =
            chart5m.quotes
                .map((q) => q.close)
                .filter(
                    (close) =>
                        close !== null &&
                        close !== undefined &&
                        !isNaN(close)
                );

        // ======================
        // 1 Min
        // ======================

        const chart1m =
            await yahooFinance.chart(symbol, {
                period1: new Date(
                    Date.now() -
                    5 * 24 * 60 * 60 * 1000
                ),
                period2: new Date(),
                interval: "1m",
            });

        const closes1m =
            chart1m.quotes
                .map((q) => q.close)
                .filter(
                    (close) =>
                        close !== null &&
                        close !== undefined &&
                        !isNaN(close)
                );

        // ======================
        // EMA
        // ======================

        let ema20 = null;
        let prevEma20 = null;

        if (dailyCloses.length >= 20) {
            const emaValues = EMA.calculate({ period: 20, values: dailyCloses });

            ema20 = emaValues[emaValues.length - 1];
            prevEma20 = emaValues.length >= 2 ? emaValues[emaValues.length - 2] : null;
        }

        let ema50 = null;
        let prevEma50 = null;

        if (dailyCloses.length >= 50) {
            const ema50Values = EMA.calculate({ period: 50, values: dailyCloses });

            ema50 = ema50Values[ema50Values.length - 1];
            prevEma50 = ema50Values.length >= 2 ? ema50Values[ema50Values.length - 2] : null;
        }

        let ema200 = null;
        let prevEma200 = null;

        if (dailyCloses.length >= 200) {
            const ema200Values = EMA.calculate({ period: 200, values: dailyCloses });

            ema200 = ema200Values[ema200Values.length - 1];
            prevEma200 = ema200Values.length >= 2 ? ema200Values[ema200Values.length - 2] : null;
        }


        let sma20 = null;
        let prevSma20 = null;

        if (dailyCloses.length >= 20) {
            const sma20Values = SMA.calculate({ period: 20, values: dailyCloses });

            sma20 = sma20Values[sma20Values.length - 1];
            prevSma20 = sma20Values.length >= 2 ? sma20Values[sma20Values.length - 2] : null;
        }

        let sma50 = null;
        let prevSma50 = null;

        if (dailyCloses.length >= 50) {
            const sma50Values = SMA.calculate({ period: 50, values: dailyCloses });

            sma50 = sma50Values[sma50Values.length - 1];
            prevSma50 = sma50Values.length >= 2 ? sma50Values[sma50Values.length - 2] : null;
        }

        // ======================
        // RSI Calculations
        // ======================

        const dailyRsi =
            calculateRsiData(dailyCloses);

        const hourlyRsiData =
            calculateRsiData(hourlyCloses);

        const rsi15mData =
            calculateRsiData(closes15m);

        const rsi5mData =
            calculateRsiData(closes5m);

        const rsi1mData =
            calculateRsiData(closes1m);

        const prevPrice = dailyCloses.length >= 2 ? dailyCloses[dailyCloses.length - 2] : null;

        return {
            symbol,

            price:
                quote.regularMarketPrice ??
                0,

            change:
                quote.regularMarketChangePercent ??
                0,

            volume:
                quote.regularMarketVolume ??
                0,

            pe:
                quote.trailingPE ?? 0,

            ema20:
                ema20 !== null
                    ? Number(
                        ema20.toFixed(2)
                    )
                    : null,
            ema50:
                ema50 !== null
                    ? Number(ema50.toFixed(2))
                    : null,

            ema200:
                ema200 !== null
                    ? Number(ema200.toFixed(2))
                    : null,

            prevEma20: prevEma20 !== null ? Number(prevEma20.toFixed(2)) : null,
            prevEma50: prevEma50 !== null ? Number(prevEma50.toFixed(2)) : null,
            prevEma200: prevEma200 !== null ? Number(prevEma200.toFixed(2)) : null,

            sma20:
                sma20 !== null
                    ? Number(sma20.toFixed(2))
                    : null,

            sma50:
                sma50 !== null
                    ? Number(sma50.toFixed(2))
                    : null,

            prevSma20: prevSma20 !== null ? Number(prevSma20.toFixed(2)) : null,
            prevSma50: prevSma50 !== null ? Number(prevSma50.toFixed(2)) : null,

            volumeChange:
                volumeChange !== null
                    ? Number(volumeChange.toFixed(2))
                    : null,

            high52Pct:
                high52Pct !== null
                    ? Number(high52Pct.toFixed(2))
                    : null,

            low52Pct:
                low52Pct !== null
                    ? Number(low52Pct.toFixed(2))
                    : null,

            // Daily

            rsi:
                dailyRsi.rsi !== null
                    ? Number(
                        dailyRsi.rsi.toFixed(
                            2
                        )
                    )
                    : null,

            prevRsi:
                dailyRsi.prev !== null &&
                    dailyRsi.prev !== undefined
                    ? Number(
                        dailyRsi.prev.toFixed(
                            2
                        )
                    )
                    : null,

            rsiChange:
                dailyRsi.change !== null
                    ? Number(
                        dailyRsi.change.toFixed(
                            2
                        )
                    )
                    : null,

            // Hourly

            hourlyRsi:
                hourlyRsiData.rsi !== null
                    ? Number(
                        hourlyRsiData.rsi.toFixed(
                            2
                        )
                    )
                    : null,

            prevHourlyRsi:
                hourlyRsiData.prev !==
                    null &&
                    hourlyRsiData.prev !==
                    undefined
                    ? Number(
                        hourlyRsiData.prev.toFixed(
                            2
                        )
                    )
                    : null,

            hourlyRsiChange:
                hourlyRsiData.change !==
                    null
                    ? Number(
                        hourlyRsiData.change.toFixed(
                            2
                        )
                    )
                    : null,

            // 15 Min

            rsi15m:
                rsi15mData.rsi !== null
                    ? Number(
                        rsi15mData.rsi.toFixed(
                            2
                        )
                    )
                    : null,

            prevRsi15m:
                rsi15mData.prev !==
                    null &&
                    rsi15mData.prev !==
                    undefined
                    ? Number(
                        rsi15mData.prev.toFixed(
                            2
                        )
                    )
                    : null,

            rsi15mChange:
                rsi15mData.change !==
                    null
                    ? Number(
                        rsi15mData.change.toFixed(
                            2
                        )
                    )
                    : null,

            // 5 Min

            rsi5m:
                rsi5mData.rsi !== null
                    ? Number(
                        rsi5mData.rsi.toFixed(
                            2
                        )
                    )
                    : null,

            prevRsi5m:
                rsi5mData.prev !==
                    null &&
                    rsi5mData.prev !==
                    undefined
                    ? Number(
                        rsi5mData.prev.toFixed(
                            2
                        )
                    )
                    : null,

            rsi5mChange:
                rsi5mData.change !==
                    null
                    ? Number(
                        rsi5mData.change.toFixed(
                            2
                        )
                    )
                    : null,

            // 1 Min

            rsi1m:
                rsi1mData.rsi !== null
                    ? Number(
                        rsi1mData.rsi.toFixed(
                            2
                        )
                    )
                    : null,

            prevRsi1m:
                rsi1mData.prev !==
                    null &&
                    rsi1mData.prev !==
                    undefined
                    ? Number(
                        rsi1mData.prev.toFixed(
                            2
                        )
                    )
                    : null,

            rsi1mChange:
                rsi1mData.change !==
                    null
                    ? Number(
                        rsi1mData.change.toFixed(
                            2
                        )
                    )
                    : null,
            prevPrice: prevPrice !== null ? Number(prevPrice.toFixed(2)) : null,
        };
    } catch (error) {
        console.log(
            "Yahoo Error:",
            symbol
        );
        console.log(error);

        return {
            symbol,
            price: 0,
            change: 0,
            volume: 0,
            pe: 0,

            ema20: null,
            ema50: null,
            ema200: null,

            sma20: null,
            sma50: null,

            volumeChange: null,

            high52Pct: null,
            low52Pct: null,

            rsi: null,
            prevRsi: null,
            rsiChange: null,

            hourlyRsi: null,
            prevHourlyRsi: null,
            hourlyRsiChange: null,

            rsi15m: null,
            prevRsi15m: null,
            rsi15mChange: null,

            rsi5m: null,
            prevRsi5m: null,
            rsi5mChange: null,

            rsi1m: null,
            prevRsi1m: null,
            rsi1mChange: null,
        };
    }
}

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
            return "CRYPTO";

        default:
            return exchange || "UNKNOWN";
    }
}


// use unified evaluator for condition and strategy evaluation
const { evaluateCondition, evaluateStrategy, getBacktestStartIndex } = evaluator;

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


function buildBacktestIndicators(candles) {
    const closes = candles.map(c => c.close);

    const rsiValues = RSI.calculate({
        period: 14,
        values: closes,
    });

    const ema20Values = EMA.calculate({
        period: 20,
        values: closes,
    });

    const ema50Values = EMA.calculate({
        period: 50,
        values: closes,
    });

    const ema200Values = EMA.calculate({
        period: 200,
        values: closes,
    });

    const sma20Values = SMA.calculate({
        period: 20,
        values: closes,
    });

    const sma50Values = SMA.calculate({
        period: 50,
        values: closes,
    });

    return candles.map((candle, index) => ({
        date: candle.date,

        price: candle.close,
        volume: candle.volume,

        rsi: rsiValues[index - 14] || null,

        ema20: ema20Values[index - 19] || null,
        ema50: ema50Values[index - 49] || null,
        ema200: ema200Values[index - 199] || null,

        sma20: sma20Values[index - 19] || null,
        sma50: sma50Values[index - 49] || null,

        change: 0,
        pe: 0,
        volumeChange: 0,
        high52Pct: 0,
        low52Pct: 0,
    }));
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

            const marketData =
                await Promise.all(
                    watchlist.stocks.map(
                        (stock) =>
                            getMarketData(
                                stock.symbol
                            )
                    )
                );

            const conditions =
                strategy.entryConditions?.length
                    ? strategy.entryConditions
                    : strategy.conditions ||
                    [];

            const matches = marketData.filter((stock) => {
                const previous = buildPreviousFromCurrent(stock);

                return evaluateStrategy(stock, previous, conditions, strategy.logic || "AND");
            });

            return res.json({
                strategy:
                    strategy.name,
                matched:
                    matches.length,
                matches,
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
        const data = await getMarketData(req.params.symbol);

        res.json({
            availableIndicators: {
                Price: data.price,
                "Price Change %": data.change,

                RSI14: data.rsi,
                "RSI Change": data.rsiChange,

                EMA20: data.ema20,
                EMA50: data.ema50,
                EMA200: data.ema200,

                SMA20: data.sma20,
                SMA50: data.sma50,

                Volume: data.volume,
                "Volume Change %": data.volumeChange,

                "PE Ratio": data.pe,

                "52 Week High %": data.high52Pct,
                "52 Week Low %": data.low52Pct,
            },

            rawData: data,
        });
    } catch (error) {
        res.status(500).json({
            message: error.message,
        });
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
                mongoId: user._id,
                name: user.name,
                email: user.email,
            },
            process.env.JWT_SECRET || "dev-secret",
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
        const quote = await yahooFinance.quote("TCS.NS");

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

app.get("/api/market-data/:watchlistId", async (req, res) => {
    try {
        const watchlist = await Watchlist.findById(req.params.watchlistId);
        if (!watchlist) return res.status(404).json({ message: "Watchlist not found" });
        if (watchlist.userId && watchlist.userId.toString() !== req.query.userId && req.headers.authorization) {
            // if userId is provided in query enforce it matches
        }

        // enforce ownership if possible (best effort)
        // check cache
        const cacheKey = `market:${req.params.watchlistId}`;
        const cached = getCache(cacheKey);
        if (cached) return res.json(cached);

        const marketData = await Promise.all(watchlist.stocks.map((stock) => getMarketData(stock.symbol)));
        setCache(cacheKey, marketData, 30);

        res.json(marketData);
    } catch (error) {
        res.status(500).json({
            message: error.message,
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
                const quote = await yahooFinance.quote(stock.symbol);

                const summary = await yahooFinance.quoteSummary(
                    stock.symbol,
                    {
                        modules: ["assetProfile"],
                    }
                );

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

        const result = await yahooFinance.search(q);

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
        const quote = await yahooFinance.quote(symbol);

        let profile = {};
        try {
            const summary = await yahooFinance.quoteSummary(symbol, { modules: ["assetProfile"] });
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
        if (watchlist.userId && watchlist.userId.toString() !== req.user.mongoId) return res.status(403).json({ message: "Forbidden" });

        watchlist.stocks = watchlist.stocks.filter((stock) => stock.symbol !== req.params.symbol);
        await watchlist.save();

        res.json(watchlist);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});



app.get("/api/strategy-details/:id", async (req, res) => {
    try {
        const strategy = await Strategy.findById(req.params.id);

        if (!strategy) {
            return res.status(404).json({
                message: "Strategy not found",
            });
        }

        res.json(strategy);
    } catch (error) {
        console.log(error);

        res.status(500).json({
            message: "Failed to fetch strategy",
        });
    }
});

app.post("/api/backtest/run", requireAuth, async (req, res) => {
    try {
        if (!rateLimit(req.ip, 4, 60)) return res.status(429).json({ message: "Too many requests" });
        const {
            strategyId,
            symbol,
            period,
            capital = 10000,
        } = req.body;

        if (!symbol) return res.status(400).json({ message: "Symbol required" });

        const strategy = await Strategy.findById(strategyId);
        if (!strategy) return res.status(404).json({ message: "Strategy not found" });

        const daysMap = {
            "1mo": 30,
            "3mo": 90,
            "6mo": 180,
            "1y": 365,
            "2y": 730,
            "5y": 1825,
        };

        const chart =
            await yahooFinance.chart(symbol, {
                period1: new Date(
                    Date.now() -
                    daysMap[period] *
                    24 *
                    60 *
                    60 *
                    1000
                ),
                period2: new Date(),
                interval: "1d",
            });

        const candles = chart.quotes.filter(
            q =>
                q.close !== null &&
                q.close !== undefined
        );

        const data = buildBacktestIndicators(candles);

        const trades = [];

        let equity = capital;

        const equityCurve = [];

        let inPosition = false;

        let entryPrice = 0;
        let entryDate = null;

        const entryConditions = strategy.entryConditions?.length ? strategy.entryConditions : strategy.conditions || [];

        const exitConditions = strategy.exitConditions || [];

        const startIndex = getBacktestStartIndex(entryConditions, exitConditions);

        for (let i = startIndex; i < data.length; i++) {
            const current = data[i];
            const previous = data[i - 1];

            const entrySignal = evaluateStrategy(current, previous, entryConditions, strategy.logic || "AND");
            const exitSignal = evaluateStrategy(current, previous, exitConditions, strategy.logic || "AND");

            if (!inPosition && entrySignal) {
                entryPrice = current.price;
                entryDate = current.date;
                inPosition = true;
                continue;
            }

            if (!inPosition) continue;

            const stopLossHit = strategy.stopLoss > 0 && current.price <= entryPrice * (1 - strategy.stopLoss / 100);
            const targetHit = strategy.target > 0 && current.price >= entryPrice * (1 + strategy.target / 100);

            if (exitSignal || stopLossHit || targetHit) {
                const stopLossPrice = entryPrice * (1 - strategy.stopLoss / 100);
                const targetPrice = entryPrice * (1 + strategy.target / 100);

                const exitPrice = stopLossHit ? stopLossPrice : targetHit ? targetPrice : current.price;

                const returnPct = ((exitPrice - entryPrice) / entryPrice) * 100;
                const profit = equity * (returnPct / 100);

                equity += profit;

                trades.push({
                    entryDate,
                    exitDate: current.date,
                    entryPrice: Number(entryPrice.toFixed(2)),
                    exitPrice: Number(exitPrice.toFixed(2)),
                    returnPct: Number(returnPct.toFixed(2)),
                    profit: Number(profit.toFixed(2)),
                    reason: stopLossHit ? "Stop Loss" : targetHit ? "Target" : "Exit Signal",
                });

                equityCurve.push({ date: current.date, equity: Number(equity.toFixed(2)) });

                inPosition = false;
            }
        }

        const returns = trades.map((t) => t.returnPct);
        const wins = trades.filter((t) => t.returnPct > 0);
        const losses = trades.filter((t) => t.returnPct <= 0);

        const sumWins = wins.reduce((s, t) => s + t.profit, 0);
        const sumLosses = losses.reduce((s, t) => s + Math.abs(t.profit), 0);

        const avgWin = wins.length ? Number((wins.reduce((s, t) => s + t.returnPct, 0) / wins.length).toFixed(2)) : 0;
        const avgLoss = losses.length ? Number((losses.reduce((s, t) => s + t.returnPct, 0) / losses.length).toFixed(2)) : 0;

        const profitFactor = sumLosses > 0 ? Number((sumWins / sumLosses).toFixed(2)) : sumWins > 0 ? Infinity : 0;

        const largestWinningTrade = returns.length ? Math.max(...returns) : 0;
        const largestLosingTrade = returns.length ? Math.min(...returns) : 0;

        // max drawdown
        let maxDrawdown = 0;
        let peak = -Infinity;
        for (const point of equityCurve) {
            if (point.equity > peak) peak = point.equity;
            const dd = peak > 0 ? ((peak - point.equity) / peak) * 100 : 0;
            if (dd > maxDrawdown) maxDrawdown = dd;
        }

        // buy & hold
        const buyAndHoldReturn = candles.length >= 2 ? Number((((candles[candles.length - 1].close - candles[0].close) / candles[0].close) * 100).toFixed(2)) : 0;

        const summary = {
            totalTrades: trades.length,
            winRate: trades.length ? Number(((wins.length / trades.length) * 100).toFixed(2)) : 0,
            avgReturn: trades.length ? Number((returns.reduce((a, b) => a + b, 0) / trades.length).toFixed(2)) : 0,
            bestTrade: returns.length ? Math.max(...returns) : 0,
            worstTrade: returns.length ? Math.min(...returns) : 0,
            finalCapital: Number(equity.toFixed(2)),
            totalReturn: Number((((equity - capital) / capital) * 100).toFixed(2)),

            profitFactor,
            averageWin: avgWin,
            averageLoss: avgLoss,
            maxDrawdown: Number(maxDrawdown.toFixed(2)),
            largestWinningTrade,
            largestLosingTrade,
            buyAndHoldReturn,
        };

        // persist backtest for authenticated user
        try {
            const userId = req.user?.mongoId;
            if (userId) {
                await Backtest.create({ userId, strategyId, symbol, period, capital, metrics: summary, trades, equityCurve });
            }
        } catch (err) {
            console.log("Failed to save backtest:", err);
        }

        res.json({ strategy: strategy.name, summary, trades, equityCurve });
    } catch (error) {
        console.log(error);

        res.status(500).json({
            message: "Backtest failed",
        });
    }
});

// Get backtests for a user
app.get("/api/backtests/:userId", requireAuth, async (req, res) => {
    try {
        if (req.user.mongoId !== req.params.userId) return res.status(403).json({ message: "Forbidden" });

        const backtests = await Backtest.find({ userId: req.params.userId }).sort({ createdAt: -1 });
        res.json(backtests);
    } catch (err) {
        console.log(err);
        res.status(500).json({ message: "Failed to fetch backtests" });
    }
});


const PORT = process.env.PORT || 5001;

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
