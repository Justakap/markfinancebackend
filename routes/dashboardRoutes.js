const express = require("express");

function createDashboardRoutes({ Watchlist, Strategy, Backtest, requireAuth, getMetrics, upstoxMarketData }) {
    const router = express.Router();

    router.get("/dashboard", requireAuth, async (req, res) => {
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

    router.get("/metrics", requireAuth, async (req, res) => {
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

    return router;
}

module.exports = { createDashboardRoutes };
