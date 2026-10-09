const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
require("dotenv").config();

const Watchlist = require("./models/Watchlist");
const User = require("./models/User");
const Strategy = require("./models/Strategy");
const Backtest = require("./models/Backtest");
const StrategyDefinition = require("./models/StrategyDefinition");
const StrategyVersion = require("./models/StrategyVersion");
const BacktestResult = require("./models/BacktestResult");
const BacktestTrade = require("./models/BacktestTrade");
const LiveStrategyRuntime = require("./models/LiveStrategyRuntime");
const LiveStrategySignal = require("./models/LiveStrategySignal");
const AlertConfiguration = require("./models/AlertConfiguration");
const Notification = require("./models/Notification");
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
    rateLimit,
    searchRateLimit,
    authLimiter,
    backtestLimiter,
    optionChainLimiter,
    liveStrategyLimiter,
    writeLimiter,
} = require("./middleware/rateLimiters");
const {
    runBacktestSimulation,
    fetchBacktestCandles,
    getStrategyInterval,
    resolveBacktestConfig,
    INTERVAL_CONFIG,
    INTERVAL_TO_UPSTOX,
    strategyUsesPe,
    CORPORATE_ACTIONS_NOTE,
} = require("./utils/backtestEngine");
const { runIndicatorValidation } = require("./utils/validationService");
const { runStrategyScan } = require("./services/strategyScanService");
const upstoxMarketData = require("./services/marketDataService");
const { resolveInstrumentKey } = require("./utils/instrumentKeyResolver");
const { SAMPLE_STRATEGIES } = require("./utils/sampleStrategies");
const { getPeForInstrument } = require("./services/fundamentalService");
const {
    getOptionChain,
    getOptionExpiries,
    isValidExpiryFormat,
} = require("./services/optionChainService");
const { runAndPersistBacktest } = require("./services/professionalBacktestService");
const { fetchHistoricalCandlesByRange, toBacktestQuote } = require("./services/candleService");
const { createStrategy: createProfessionalStrategy, createNewVersion: createProfessionalStrategyVersion } = require("./services/strategyVersionService");
const { getMetrics, recordScanTime, recordBacktestTime } = require("./utils/metrics");
const http = require("http");
const { Server } = require("socket.io");
const { createStockAnalysisRoutes } = require("./routes/stockAnalysisRoutes");
const { createAuthRoutes } = require("./routes/authRoutes");
const { createDebugRoutes } = require("./routes/debugRoutes");
const { createStrategyRoutes } = require("./routes/strategyRoutes");
const { createWatchlistRoutes } = require("./routes/watchlistRoutes");
const { createBacktestRoutes } = require("./routes/backtestRoutes");
const { createDashboardRoutes } = require("./routes/dashboardRoutes");
const { createOptionChainRoutes } = require("./routes/optionChainRoutes");
const { createProfessionalBacktestRoutes } = require("./routes/professionalBacktestRoutes");
const { createProfessionalStrategyRoutes } = require("./routes/professionalStrategyRoutes");
const { createLiveStrategyRoutes } = require("./routes/liveStrategyRoutes");
const { activateLiveStrategy, deactivateLiveStrategy } = require("./services/liveStrategyService");
const { startLiveEnginePolling, stopLiveEnginePolling } = require("./services/liveStrategyOrchestrator");
const { createAlertRoutes } = require("./routes/alertRoutes");
const {
    createAlertConfiguration,
    updateAlertConfiguration,
    archiveAlertConfiguration,
} = require("./services/alertConfigurationService");
const { startAlertProcessingPolling, stopAlertProcessingPolling } = require("./services/alertNotificationService");

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

app.use("/api", createAuthRoutes({ User, Watchlist, getJwtSecret, authLimiter }));

app.use(
    "/api",
    createDebugRoutes({
        requireAuth,
        VALIDATION_MODE,
        upstoxMarketData,
        resolveInstrumentKey,
        runIndicatorValidation,
    }),
);

app.use(
    "/api",
    createStrategyRoutes({
        Strategy,
        Watchlist,
        requireAuth,
        validateObjectId,
        rateLimit,
        runStrategyScan,
        recordScanTime,
        SAMPLE_STRATEGIES,
        getStrategyInterval,
        resolveBacktestConfig,
        INTERVAL_CONFIG,
    }),
);

app.use(
    "/api",
    createWatchlistRoutes({
        Watchlist,
        requireAuth,
        validateObjectId,
        upstoxMarketData,
        getPeForInstrument,
    }),
);

app.use(
    "/api",
    createBacktestRoutes({
        Strategy,
        Backtest,
        requireAuth,
        validateObjectId,
        backtestLimiter,
        resolveInstrumentKey,
        fetchBacktestCandles,
        runBacktestSimulation,
        getPeForInstrument,
        strategyUsesPe,
        CORPORATE_ACTIONS_NOTE,
        upstoxMarketData,
        recordBacktestTime,
        VALIDATION_MODE,
    }),
);

app.use(
    "/api",
    createDashboardRoutes({
        Watchlist,
        Strategy,
        Backtest,
        requireAuth,
        getMetrics,
        upstoxMarketData,
    }),
);

app.use(
    "/api",
    createOptionChainRoutes({
        requireAuth,
        optionChainLimiter,
        upstoxMarketData,
        getOptionChain,
        getOptionExpiries,
        isValidExpiryFormat,
    }),
);

app.use(
    "/api",
    createProfessionalBacktestRoutes({
        StrategyDefinition,
        StrategyVersion,
        BacktestResult,
        BacktestTrade,
        requireAuth,
        validateObjectId,
        backtestLimiter,
        resolveInstrumentKey,
        upstoxMarketData,
        runAndPersistBacktest,
        fetchHistoricalCandlesByRange,
        toBacktestQuote,
        INTERVAL_TO_UPSTOX,
        INTERVAL_CONFIG,
    }),
);

app.use(
    "/api",
    createProfessionalStrategyRoutes({
        StrategyDefinition,
        StrategyVersion,
        requireAuth,
        validateObjectId,
        createStrategy: createProfessionalStrategy,
        createNewVersion: createProfessionalStrategyVersion,
    }),
);

app.use(
    "/api",
    createLiveStrategyRoutes({
        StrategyDefinition,
        StrategyVersion,
        LiveStrategyRuntime,
        LiveStrategySignal,
        requireAuth,
        validateObjectId,
        liveStrategyLimiter,
        resolveInstrumentKey,
        activateLiveStrategy,
        deactivateLiveStrategy,
    }),
);

app.use(
    "/api",
    createAlertRoutes({
        LiveStrategyRuntime,
        AlertConfiguration,
        Notification,
        requireAuth,
        validateObjectId,
        createAlertConfiguration,
        updateAlertConfiguration,
        archiveAlertConfiguration,
    }),
);

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

    // Workstream J — polls ACTIVE LiveStrategyRuntime documents on an
    // interval, reusing the existing Upstox queue/candle-cache path
    // through liveCandleFeed.js. Not a second WebSocket connection; see
    // services/liveStrategyOrchestrator.js's file doc comment.
    startLiveEnginePolling({ LiveStrategyRuntime, LiveStrategySignal, StrategyVersion });
    console.log("Live strategy engine polling enabled");

    // Workstream K — consumes LiveStrategySignal as a durable outbox and
    // produces de-duplicated Notification documents; see
    // services/alertNotificationService.js's file doc comment.
    startAlertProcessingPolling({ LiveStrategyRuntime, LiveStrategySignal, AlertConfiguration, Notification });
    console.log("Alert notification polling enabled");

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
            stopAlertProcessingPolling();
            stopLiveEnginePolling();
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
