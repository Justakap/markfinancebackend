const express = require("express");

function createStockAnalysisRoutes({
    Watchlist,
    requireAuth,
    ownsResource,
    rateLimit,
    searchRateLimit,
    upstoxMarketData,
}) {
    const router = express.Router();

    router.get("/market-data/:watchlistId", requireAuth, async (req, res) => {
        if (!rateLimit(`market:${req.ip}`, 60, 60)) {
            return res.status(429).json({
                message: "Too many market data requests. Wait a moment and retry.",
            });
        }

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

            const result = await upstoxMarketData.getRowsForWatchlist(watchlist);

            return res.json({
                data: result.data,
                total: result.total,
                offset: 0,
                limit: result.total,
                fromCache: true,
                marketStatus: result.marketStatus,
                updatedAt: result.updatedAt,
                responseTimeMs: Date.now() - start,
            });
        } catch (error) {
            console.log("Market data error:", error);
            return res.status(500).json({
                message: error.message || "Failed to load market data",
            });
        }
    });

    router.get("/search", async (req, res) => {
        if (!searchRateLimit(req.ip)) {
            return res.status(429).json({
                message: "Too many search requests. Wait a moment and try again.",
            });
        }

        try {
            const q = req.query.q;

            if (!q || String(q).trim().length < 2) {
                return res.json([]);
            }

            const stocks = await upstoxMarketData.searchInstruments(q);

            return res.json(stocks);
        } catch (error) {
            console.log(error);

            return res.status(500).json({
                message: "Search failed",
            });
        }
    });

    // Legacy alias — same Upstox instrument search
    router.get("/search-stock", async (req, res) => {
        if (!searchRateLimit(req.ip)) {
            return res.status(429).json({
                message: "Too many search requests. Wait a moment and try again.",
            });
        }

        try {
            const stocks = await upstoxMarketData.searchInstruments(req.query.q || "");
            return res.json(stocks);
        } catch (error) {
            console.log(error);
            return res.status(500).json({ message: "Search failed" });
        }
    });

    return router;
}

module.exports = {
    createStockAnalysisRoutes,
};
