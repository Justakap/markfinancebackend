const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const helmet = require("helmet");
const expressRateLimit = require("express-rate-limit");
require("dotenv").config();

const Watchlist = require("./models/Watchlist");
const User = require("./models/User");
const Strategy = require("./models/Strategy");
const Backtest = require("./models/Backtest");
const jwt = require("jsonwebtoken");
const { requireAuth } = require("./middleware/auth");
const { validateObjectId } = require("./middleware/validateObjectId");
const { getJwtSecret } = require("./config/jwt");
const { isOriginAllowed } = require("./config/cors");
const { notFoundHandler, errorHandler } = require("./middleware/errorHandler");
const {
    connectDatabase,
    disconnectDatabase,
    isDatabaseConnected,
} = require("./config/database");
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

try {
    getJwtSecret();
} catch (error) {
    console.error(error.message);
    process.exit(1);
}

const app = express();

app.set("trust proxy", 1);

app.use(
    helmet({
        // Pure JSON API — no HTML pages to protect with a CSP, and a default CSP can
        // confuse API clients/tools for no benefit here.
        contentSecurityPolicy: false,
        // The frontend lives on a different origin (Netlify); must not block cross-origin fetches.
        crossOriginResourcePolicy: { policy: "cross-origin" },
    }),
);

app.use(
    cors({
        origin(origin, callback) {
            if (isOriginAllowed(origin)) return callback(null, true);
            return callback(new Error("Not allowed by CORS"));
        },
    }),
);

app.use(express.json());

// Simple rate limiter per IP (used by search/market-data routes which need a high, debounce-friendly ceiling).
const rateMap = new Map();
const RATE_ENTRY_MAX_AGE_MS = 10 * 60 * 1000;

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

// Stale IP entries must not grow the map forever.
const rateMapCleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of rateMap) {
        if (now - entry.start > RATE_ENTRY_MAX_AGE_MS) {
            rateMap.delete(key);
        }
    }
}, 5 * 60 * 1000);
rateMapCleanup.unref();

// Search is local (instrument master cache) — allow frequent debounced typing
function searchRateLimit(ip, limit = 120, windowSec = 60) {
    return rateLimit(`search:${ip}`, limit, windowSec);
}

// express-rate-limit (self-expiring store) for sensitive/expensive endpoints.
const authLimiter = expressRateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: "Too many login attempts. Try again later." },
});

const backtestLimiter = expressRateLimit({
    windowMs: 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: "Too many backtest requests. Wait a moment and retry." },
});

// Generous safety net on all other mutating /api requests — not meant to bother normal usage.
const writeLimiter = expressRateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: "Too many requests. Please slow down." },
    skip: (req) => req.method === "GET",
});

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
app.use("/api", writeLimiter);
app.use(
    "/api",
    createStockAnalysisRoutes({
        Watchlist,
        requireAuth,
        rateLimit,
        searchRateLimit,
        upstoxMarketData,
    }),
);

async function resolveInstrumentKey(symbol, instrumentKey) {
    return resolveUpstoxInstrumentKey(symbol, instrumentKey);
}

// run strategy

app.post("/api/strategies/run", requireAuth, async (req, res) => {
    if (!rateLimit(req.ip, 20, 60)) {
        return res.status(429).json({
            message: "Too many scan requests. Wait a moment and retry.",
        });
    }
    try {
        const { strategyId, watchlistId } = req.body;

        if (!mongoose.Types.ObjectId.isValid(strategyId) || !mongoose.Types.ObjectId.isValid(watchlistId)) {
            return res.status(400).json({ message: "Invalid identifier" });
        }

        const strategy = await Strategy.findOne({
            _id: strategyId,
            userId: req.user.mongoId,
        });

        const watchlist = await Watchlist.findOne({
            _id: watchlistId,
            userId: req.user.mongoId,
        });

        if (!strategy) {
            return res.status(404).json({ message: "Strategy not found" });
        }

        if (!watchlist) {
            return res.status(404).json({ message: "Watchlist not found" });
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
        console.error("Strategy run error:", error);
        return res.status(500).json({ message: "Failed to run strategy" });
    }
});

// Debug/diagnostic endpoints — require auth and are only enabled when VALIDATION_MODE is on
// (off by default in production unless ENABLE_VALIDATION_MODE=true). They must never be
// reachable anonymously in production.
app.get("/api/debug/:symbol", requireAuth, async (req, res) => {
    if (!VALIDATION_MODE) {
        return res.status(403).json({ message: "Debug endpoints disabled" });
    }

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
        console.error("Debug endpoint error:", error);
        res.status(500).json({ message: "Failed to load debug data" });
    }
});

app.get("/api/validation/indicators", requireAuth, async (req, res) => {
    if (!VALIDATION_MODE) {
        return res.status(403).json({ message: "Validation mode disabled" });
    }

    try {
        const report = await runIndicatorValidation();
        res.json(report);
    } catch (error) {
        console.error("Validation indicators error:", error);
        res.status(500).json({ message: "Validation failed" });
    }
});

app.get("/api/validation/debug/:symbol", requireAuth, async (req, res) => {
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
        console.error("Validation debug error:", error);
        res.status(500).json({ message: "Validation failed" });
    }
});

// google login

app.post("/api/auth/google", authLimiter, async (req, res) => {
    try {
        const { uid, name, email, photoURL } = req.body;

        if (typeof uid !== "string" || typeof email !== "string" || !uid || !email) {
            return res.status(400).json({
                success: false,
                message: "Google uid and email are required",
            });
        }

        if (name != null && typeof name !== "string") {
            return res.status(400).json({ success: false, message: "Invalid name" });
        }

        if (photoURL != null && typeof photoURL !== "string") {
            return res.status(400).json({ success: false, message: "Invalid photoURL" });
        }

        let user = await User.findOne({
            $or: [{ googleId: uid }, { email }],
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
        console.error("Google auth error:", error);
        res.status(500).json({
            success: false,
            message: "Authentication failed",
        });
    }
});

// Strategy

app.post("/api/strategies", requireAuth, async (req, res) => {
    try {
        const { name, description, entryConditions, exitConditions, stopLoss, target, logic, alertEnabled } =
            req.body;

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
        console.error("Create strategy error:", error);
        res.status(500).json({ message: "Failed to create strategy" });
    }
});

app.get("/api/strategies/:userId", requireAuth, async (req, res) => {
    try {
        if (req.user.mongoId !== req.params.userId) return res.status(403).json({ message: "Forbidden" });

        const strategies = await Strategy.find({ userId: req.user.mongoId }).sort({ createdAt: -1 });

        res.json(strategies);
    } catch (error) {
        console.error("List strategies error:", error);
        res.status(500).json({ message: "Failed to fetch strategies" });
    }
});

app.put("/api/strategies/:id", requireAuth, validateObjectId("id"), async (req, res) => {
    try {
        const strategy = await Strategy.findOneAndUpdate(
            { _id: req.params.id, userId: req.user.mongoId },
            req.body,
            { returnDocument: "after" },
        );

        if (!strategy) return res.status(404).json({ message: "Strategy not found" });

        res.json(strategy);
    } catch (error) {
        console.error("Update strategy error:", error);
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
        console.error("Seed sample strategies error:", error);
        res.status(500).json({ message: "Failed to seed sample strategies" });
    }
});

app.delete("/api/strategies/:id", requireAuth, validateObjectId("id"), async (req, res) => {
    try {
        const strategy = await Strategy.findOneAndDelete({
            _id: req.params.id,
            userId: req.user.mongoId,
        });

        if (!strategy) return res.status(404).json({ message: "Strategy not found" });

        res.json({ success: true, message: "Strategy deleted" });
    } catch (error) {
        console.error("Delete strategy error:", error);
        res.status(500).json({ message: "Failed to delete strategy" });
    }
});

app.post("/api/watchlists/:id/refresh-fundamentals", requireAuth, validateObjectId("id"), async (req, res) => {
    try {
        const watchlist = await Watchlist.findOne({
            _id: req.params.id,
            userId: req.user.mongoId,
        });

        if (!watchlist) return res.status(404).json({ message: "Watchlist not found" });

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
                console.log("Failed:", stock.symbol);
            }
        }

        await watchlist.save();

        res.json({
            message: "Fundamentals refreshed",
        });
    } catch (error) {
        console.error("Refresh fundamentals error:", error);
        res.status(500).json({ message: "Server Error" });
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
        console.error("Create watchlist error:", error);
        res.status(500).json({ message: "Failed to create watchlist" });
    }
});

// =======================
// Get All Watchlists
// =======================
app.get("/api/watchlists", requireAuth, async (req, res) => {
    try {
        const watchlists = await Watchlist.find({ userId: req.user.mongoId }).sort({ createdAt: -1 });
        res.json(watchlists);
    } catch (error) {
        console.error("List watchlists error:", error);
        res.status(500).json({ message: "Failed to fetch watchlists" });
    }
});

// =======================
// Get Single Watchlist
// =======================

app.get("/api/watchlists/:id", requireAuth, validateObjectId("id"), async (req, res) => {
    try {
        const watchlist = await Watchlist.findOne({ _id: req.params.id, userId: req.user.mongoId });
        if (!watchlist) return res.status(404).json({ message: "Watchlist not found" });
        res.json(watchlist);
    } catch (error) {
        console.error("Get watchlist error:", error);
        res.status(500).json({ message: "Failed to fetch watchlist" });
    }
});

// =======================
// Rename Watchlist
// =======================

app.put("/api/watchlists/:id", requireAuth, validateObjectId("id"), async (req, res) => {
    try {
        const { name } = req.body;
        if (!name || !name.trim()) return res.status(400).json({ message: "Watchlist name required" });

        const watchlist = await Watchlist.findOneAndUpdate(
            { _id: req.params.id, userId: req.user.mongoId },
            { name: name.trim() },
            { returnDocument: "after" },
        );

        if (!watchlist) return res.status(404).json({ message: "Watchlist not found" });

        res.json(watchlist);
    } catch (error) {
        console.error("Rename watchlist error:", error);
        res.status(500).json({ message: "Failed to rename watchlist" });
    }
});

// =======================
// Delete Watchlist
// =======================

app.delete("/api/watchlists/:id", requireAuth, validateObjectId("id"), async (req, res) => {
    try {
        const watchlist = await Watchlist.findOneAndDelete({
            _id: req.params.id,
            userId: req.user.mongoId,
        });

        if (!watchlist) return res.status(404).json({ message: "Watchlist not found" });

        res.json({ message: "Watchlist deleted" });
    } catch (error) {
        console.error("Delete watchlist error:", error);
        res.status(500).json({ message: "Failed to delete watchlist" });
    }
});

// =======================
// Add Stock To Watchlist
// =======================

app.post("/api/watchlists/:id/stocks", requireAuth, validateObjectId("id"), async (req, res) => {
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

        const watchlist = await Watchlist.findOne({ _id: req.params.id, userId: req.user.mongoId });
        if (!watchlist) return res.status(404).json({ message: "Watchlist not found" });

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
            upstoxMarketData.subscribe(watchlist.stocks.map((stock) => stock.instrumentKey));
        }

        res.json(watchlist);
    } catch (error) {
        console.error("Add stock error:", error);
        res.status(500).json({ message: "Failed to add stock" });
    }
});

// =======================
// Remove Stock From Watchlist
// =======================

app.delete("/api/watchlists/:id/stocks/:symbol", requireAuth, validateObjectId("id"), async (req, res) => {
    try {
        const watchlist = await Watchlist.findOne({ _id: req.params.id, userId: req.user.mongoId });
        if (!watchlist) return res.status(404).json({ message: "Watchlist not found" });

        const stockId = decodeURIComponent(req.params.symbol);

        watchlist.stocks = watchlist.stocks.filter(
            (stock) => stock.symbol !== stockId && stock.instrumentKey !== stockId,
        );

        const updated = await watchlist.save();

        upstoxMarketData.subscribe((updated?.stocks || []).map((stock) => stock.instrumentKey));

        res.json(updated);
    } catch (error) {
        console.error("Remove stock error:", error);
        res.status(500).json({ message: "Failed to remove stock" });
    }
});

app.post("/api/watchlists/:id/stocks/bulk-remove", requireAuth, validateObjectId("id"), async (req, res) => {
    try {
        const { symbols = [] } = req.body;

        if (!Array.isArray(symbols) || !symbols.length) {
            return res.status(400).json({ message: "symbols array required" });
        }

        const watchlist = await Watchlist.findOne({ _id: req.params.id, userId: req.user.mongoId });
        if (!watchlist) return res.status(404).json({ message: "Watchlist not found" });

        const symbolSet = new Set(symbols.map(String));
        watchlist.stocks = watchlist.stocks.filter(
            (stock) => !symbolSet.has(stock.symbol) && !symbolSet.has(stock.instrumentKey),
        );

        const updated = await watchlist.save();

        upstoxMarketData.subscribe((updated?.stocks || []).map((stock) => stock.instrumentKey));

        res.json(updated);
    } catch (error) {
        console.error("Bulk remove stocks error:", error);
        res.status(500).json({ message: "Failed to remove stocks" });
    }
});

app.get("/api/strategy-details/:id", requireAuth, validateObjectId("id"), async (req, res) => {
    try {
        const strategy = await Strategy.findOne({ _id: req.params.id, userId: req.user.mongoId });

        if (!strategy) {
            return res.status(404).json({ message: "Strategy not found" });
        }

        res.json({
            ...strategy.toObject(),
            backtestInterval: getStrategyInterval(strategy),
            intervalLimits: INTERVAL_CONFIG,
            backtestPreview: resolveBacktestConfig(strategy, "1y"),
        });
    } catch (error) {
        console.error("Strategy details error:", error);
        res.status(500).json({ message: "Failed to fetch strategy" });
    }
});

app.post("/api/backtest/run", requireAuth, backtestLimiter, async (req, res) => {
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

        if (!mongoose.Types.ObjectId.isValid(strategyId)) {
            return res.status(400).json({ message: "Invalid identifier" });
        }

        const strategy = await Strategy.findOne({ _id: strategyId, userId: req.user.mongoId });
        if (!strategy) return res.status(404).json({ message: "Strategy not found" });

        const instrumentKey = await resolveInstrumentKey(symbol, bodyInstrumentKey);

        if (!instrumentKey) {
            return res.status(400).json({
                message: `No Upstox instrument found for ${symbol}. Search and pick a symbol from the list.`,
            });
        }

        const instrumentMeta = upstoxMarketData.getInstrumentMeta(instrumentKey);

        const { candles, auxiliaryCandles, config: backtestConfig } = await fetchBacktestCandles(
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
            validationMode: validationMode && VALIDATION_MODE,
            pe,
        });

        const { summary, trades, equityCurve, fullEquityCurve, signalStats, tradeMarkers, auditLog, signalLogs } =
            simulation;

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
            console.error("Failed to save backtest:", err);
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
            signalLogs: validationMode && VALIDATION_MODE ? signalLogs : undefined,
            backtestMeta,
            backtestTimeMs: Date.now() - btStart,
        });
    } catch (error) {
        recordBacktestTime(Date.now() - btStart);
        console.error("Backtest run error:", error);

        res.status(500).json({ message: "Backtest failed" });
    }
});

app.get("/api/dashboard", requireAuth, async (req, res) => {
    try {
        const userId = req.user.mongoId;

        const watchlists = await Watchlist.find({ userId });
        const stocksTracked = watchlists.reduce((sum, list) => sum + (list.stocks?.length || 0), 0);

        const strategies = await Strategy.countDocuments({ userId });
        const backtests = await Backtest.countDocuments({ userId });

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
        console.error("Dashboard error:", error);
        res.status(500).json({ message: "Failed to load dashboard" });
    }
});

app.get("/api/backtests/:userId", requireAuth, async (req, res) => {
    try {
        if (req.user.mongoId !== req.params.userId) {
            return res.status(403).json({ message: "Forbidden" });
        }

        const backtests = await Backtest.find({ userId: req.user.mongoId })
            .sort({ createdAt: -1 })
            .populate("strategyId", "name");

        res.json(backtests);
    } catch (err) {
        console.error("List backtests error:", err);
        res.status(500).json({ message: "Failed to fetch backtests" });
    }
});

app.get("/api/backtests/detail/:id", requireAuth, validateObjectId("id"), async (req, res) => {
    try {
        const backtest = await Backtest.findOne({ _id: req.params.id, userId: req.user.mongoId }).populate(
            "strategyId",
            "name",
        );

        if (!backtest) {
            return res.status(404).json({ message: "Backtest not found" });
        }

        res.json(backtest);
    } catch (err) {
        console.error("Backtest detail error:", err);
        res.status(500).json({ message: "Failed to fetch backtest" });
    }
});

app.delete("/api/backtests/:id", requireAuth, validateObjectId("id"), async (req, res) => {
    try {
        const backtest = await Backtest.findOneAndDelete({
            _id: req.params.id,
            userId: req.user.mongoId,
        });

        if (!backtest) {
            return res.status(404).json({ message: "Backtest not found" });
        }

        res.json({ success: true });
    } catch (err) {
        console.error("Delete backtest error:", err);
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
        console.error("Metrics error:", error);
        res.status(500).json({ message: "Failed to load metrics" });
    }
});

app.use(notFoundHandler);
app.use(errorHandler);

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
            origin(origin, callback) {
                if (isOriginAllowed(origin)) return callback(null, true);
                return callback(new Error("Not allowed by CORS"));
            },
            methods: ["GET", "POST"],
        },
    });

    upstoxMarketData.init(io);
    console.log("Upstox market data enabled (live quotes, strategies & backtests)");

    server.listen(PORT, () => {
        console.log(`Server running on port ${PORT} (Socket.IO enabled)`);
    });

    let shuttingDown = false;

    async function gracefulShutdown(signal) {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log(`${signal} received — shutting down gracefully`);

        const forceExitTimer = setTimeout(() => {
            console.error("Graceful shutdown timed out — forcing exit");
            process.exit(1);
        }, 10000);
        forceExitTimer.unref();

        try {
            upstoxMarketData.shutdown();
            io.close();

            await new Promise((resolve, reject) => {
                server.close((err) => (err ? reject(err) : resolve()));
            });

            await disconnectDatabase();

            clearTimeout(forceExitTimer);
            console.log("Shutdown complete");
            process.exit(0);
        } catch (error) {
            console.error("Error during shutdown:", error.message);
            process.exit(1);
        }
    }

    process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
    process.on("SIGINT", () => gracefulShutdown("SIGINT"));
}

startServer();
