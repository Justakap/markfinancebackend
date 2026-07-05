const express = require("express");
const cors = require("cors");
require("dotenv").config();

const Stock = require("./models/Stock");
const Watchlist = require("./models/Watchlist");
const User = require("./models/User");
const Strategy = require("./models/Strategy");
const Backtest = require("./models/Backtest");
const jwt = require("jsonwebtoken");
const { requireAuth } = require("./middleware/auth");
const { getJwtSecret } = require("./config/jwt");
const { connectDatabase, isDatabaseConnected } = require("./config/database");
const { requireDatabase } = require("./middleware/dbReady");
const {
    runBacktestSimulation,
    fetchBacktestCandles,
    getStrategyInterval,
    resolveBacktestConfig,
    INTERVAL_CONFIG,
} = require("./utils/backtestEngine");
const { runIndicatorValidation } = require("./utils/validationService");
const { runStrategyScan } = require("./services/strategyScanService");
const upstoxMarketData = require("./services/marketDataService");
const { resolveInstrumentKey: resolveUpstoxInstrumentKey } = require("./utils/instrumentKeyResolver");
const { SAMPLE_STRATEGIES } = require("./utils/sampleStrategies");
const { getPeForInstrument } = require("./services/fundamentalService");
const { getMetrics, recordScanTime, recordBacktestTime } = require("./utils/metrics");
const http = require("http");
const { Server } = require("socket.io");
const { createStockAnalysisRoutes } = require("./routes/stockAnalysisRoutes");

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

// Search is local (instrument master cache) — allow frequent debounced typing
function searchRateLimit(ip, limit = 120, windowSec = 60) {
    return rateLimit(`search:${ip}`, limit, windowSec);
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
app.use(
    "/api",
    createStockAnalysisRoutes({
        Watchlist,
        requireAuth,
        ownsResource,
        rateLimit,
        searchRateLimit,
        upstoxMarketData,
    }),
);

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


async function resolveInstrumentKey(symbol, instrumentKey) {
    return resolveUpstoxInstrumentKey(symbol, instrumentKey);
}


// run strategy

app.post(
    "/api/strategies/run",
    requireAuth,
    async (req, res) => {
        if (!rateLimit(req.ip, 20, 60)) {
            return res.status(429).json({
                message: "Too many scan requests. Wait a moment and retry.",
            });
        }
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

            const scanResult = await runStrategyScan(strategy, watchlist);
            recordScanTime(scanResult.scanTimeMs);

            if (!scanResult.evaluated && scanResult.skipped?.length) {
                return res.status(400).json({
                    message:
                        "No valid Upstox instrument keys on this watchlist. Remove expired F&O contracts and re-add symbols from search.",
                    skipped: scanResult.skipped,
                });
            }

            return res.json({
                strategy: strategy.name,
                matched: scanResult.matches.length,
                matches: scanResult.matches,
                scanMode: scanResult.scanMode,
                scanTimeMs: scanResult.scanTimeMs,
                dataSource: scanResult.dataSource,
                skipped: scanResult.skipped || [],
                evaluated: scanResult.evaluated,
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
        const instrumentKey = await resolveInstrumentKey(req.params.symbol);
        if (!instrumentKey) {
            return res.status(404).json({ message: "Instrument not found on Upstox" });
        }

        const row = await upstoxMarketData
            .getRowsForWatchlist({
                stocks: [
                    {
                        symbol: req.params.symbol,
                        instrumentKey,
                        name: req.params.symbol,
                    },
                ],
            })
            .then((result) => result.data[0]);

        res.json({
            availableIndicators: {
                Price: row?.price,
                "Price Change %": row?.change,
                Volume: row?.volume,
                "PE Ratio": row?.pe,
                "RSI (Daily)": row?.rsi,
                "RSI (1 Hour)": row?.hourlyRsi,
                "RSI (15 Minute)": row?.rsi15m,
                "RSI (5 Minute)": row?.rsi5m,
                EMA20: row?.ema20,
            },
            rawData: row,
            dataSource: "upstox",
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
        const instrumentKey = await resolveInstrumentKey(req.params.symbol);
        const data = instrumentKey
            ? (
                  await upstoxMarketData.getRowsForWatchlist({
                      stocks: [
                          {
                              symbol: req.params.symbol,
                              instrumentKey,
                              name: req.params.symbol,
                          },
                      ],
                  })
              ).data[0]
            : null;
        res.json({ symbol: req.params.symbol, rawData: data, dataSource: "upstox" });
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
        const instrumentKey = await resolveInstrumentKey("TCS");
        if (!instrumentKey) {
            return res.status(404).json({ message: "TCS not found on Upstox" });
        }

        const result = await upstoxMarketData.getRowsForWatchlist({
            stocks: [{ symbol: "TCS", instrumentKey, name: "TCS" }],
        });

        res.json(result.data[0] || null);
    } catch (error) {
        console.log(error);

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


app.post("/api/strategies/seed-samples", requireAuth, async (req, res) => {
    try {
        const userId = req.user.mongoId;
        const created = [];
        const existing = [];

        for (const sample of SAMPLE_STRATEGIES) {
            const found = await Strategy.findOne({
                userId,
                name: sample.name,
            });

            if (found) {
                existing.push(found.name);
                continue;
            }

            const doc = await Strategy.create({
                userId,
                ...sample,
            });
            created.push(doc.name);
        }

        res.json({
            message:
                created.length > 0
                    ? `Added ${created.length} sample strateg${created.length === 1 ? "y" : "ies"}`
                    : "Sample strategies already exist",
            created,
            existing,
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Failed to seed sample strategies" });
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
                if (!stock.instrumentKey) continue;

                const pe = await getPeForInstrument(
                    stock.instrumentKey,
                    stock.instrumentType || stock.assetType,
                );

                if (pe != null) {
                    stock.trailingPE = pe;
                }

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
        const {
            symbol,
            name,
            instrumentKey,
            exchange,
            instrumentType,
            type,
            market,
            assetType,
            sector,
            segment,
        } = req.body;

        if (!symbol || !instrumentKey) {
            return res.status(400).json({
                message: "symbol and instrumentKey are required",
            });
        }

        const watchlist = await Watchlist.findById(req.params.id);
        if (!watchlist) return res.status(404).json({ message: "Watchlist not found" });
        if (watchlist.userId && watchlist.userId.toString() !== req.user.mongoId) return res.status(403).json({ message: "Forbidden" });

        const exists = watchlist.stocks.find((stock) => stock.instrumentKey === instrumentKey);
        if (!exists) {
            watchlist.stocks.push({
                symbol,
                name,
                longName: name || "",
                instrumentKey,
                instrumentType: instrumentType || type || assetType || "",
                exchange,
                market: exchange || market,
                assetType: instrumentType || type || assetType || "",
                sector:
                    sector ||
                    segment ||
                    (exchange && (instrumentType || type)
                        ? `${exchange} · ${instrumentType || type || assetType}`
                        : exchange || "Other"),
                trailingPE: 0,
                updatedAt: new Date(),
            });

            await watchlist.save();
            upstoxMarketData.subscribe(
                watchlist.stocks.map((stock) => stock.instrumentKey),
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

        const stockId = decodeURIComponent(req.params.symbol);

        watchlist.stocks = watchlist.stocks.filter(
            (stock) => stock.symbol !== stockId && stock.instrumentKey !== stockId,
        );

        const updated = await watchlist.save();

        upstoxMarketData.subscribe(
            (updated?.stocks || []).map((stock) => stock.instrumentKey),
        );

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

        const symbolSet = new Set(symbols.map(String));
        watchlist.stocks = watchlist.stocks.filter(
            (stock) =>
                !symbolSet.has(stock.symbol) &&
                !symbolSet.has(stock.instrumentKey),
        );

        const updated = await watchlist.save();

        upstoxMarketData.subscribe(
            (updated?.stocks || []).map((stock) => stock.instrumentKey),
        );

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
            instrumentKey: bodyInstrumentKey,
            period,
            capital = 10000,
            validationMode = false,
            saveResult = true,
        } = req.body;

        if (!symbol && !bodyInstrumentKey) {
            return res.status(400).json({ message: "Symbol or instrumentKey required" });
        }

        const strategy = await Strategy.findById(strategyId);
        if (!strategy) return res.status(404).json({ message: "Strategy not found" });

        if (strategy.userId && !ownsResource(strategy.userId, req)) {
            return res.status(403).json({ message: "Forbidden" });
        }

        const instrumentKey = await resolveInstrumentKey(
            symbol,
            bodyInstrumentKey,
        );

        if (!instrumentKey) {
            return res.status(400).json({
                message: `No Upstox instrument found for ${symbol}. Search and pick a symbol from the list.`,
            });
        }

        const instrumentMeta = upstoxMarketData.getInstrumentMeta(instrumentKey);

        const { candles, auxiliaryCandles, config: backtestConfig } =
            await fetchBacktestCandles(
                instrumentKey,
                period,
                strategy,
                instrumentMeta,
            );

        if (!candles.length) {
            const derivativeHint = instrumentMeta &&
                String(instrumentMeta.instrumentType || instrumentMeta.type || "")
                    .toUpperCase()
                    .match(/FUT|OPT|CE|PE/)
                ? " For F&O, use the current contract from search (expired keys return no history)."
                : "";

            return res.status(400).json({
                message: `No Upstox candle history for ${symbol}. Try a shorter period or re-add from search.${derivativeHint}`,
            });
        }

        let pe = null;
        try {
            pe = await getPeForInstrument(instrumentKey);
        } catch {
            pe = null;
        }

        const simulation = runBacktestSimulation({
            strategy,
            candles,
            capital,
            interval: backtestConfig.interval,
            auxiliaryCandles,
            validationMode:
                validationMode && VALIDATION_MODE,
            pe,
        });

        const {
            summary,
            trades,
            equityCurve,
            fullEquityCurve,
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
            if (userId && saveResult !== false) {
                await Backtest.create({
                    userId,
                    strategyId,
                    symbol: symbol || bodyInstrumentKey,
                    instrumentKey,
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
            fullEquityCurve,
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
            dataSource: "upstox",
            subscribedInstruments: upstoxMarketData.subscribedInstruments?.size || 0,
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

    upstoxMarketData.init(io);
    console.log("Upstox market data enabled (live quotes, strategies & backtests)");

    server.listen(PORT, () => {
        console.log(`Server running on port ${PORT} (Socket.IO enabled)`);
    });
}

startServer();
