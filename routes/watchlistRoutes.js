const express = require("express");

function createWatchlistRoutes({
    Watchlist,
    requireAuth,
    validateObjectId,
    upstoxMarketData,
    getPeForInstrument,
}) {
    const router = express.Router();

    router.post("/watchlists/:id/refresh-fundamentals", requireAuth, validateObjectId("id"), async (req, res) => {
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
    router.post("/watchlists", requireAuth, async (req, res) => {
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
    router.get("/watchlists", requireAuth, async (req, res) => {
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
    router.get("/watchlists/:id", requireAuth, validateObjectId("id"), async (req, res) => {
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
    router.put("/watchlists/:id", requireAuth, validateObjectId("id"), async (req, res) => {
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
    router.delete("/watchlists/:id", requireAuth, validateObjectId("id"), async (req, res) => {
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
    router.post("/watchlists/:id/stocks", requireAuth, validateObjectId("id"), async (req, res) => {
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
    router.delete("/watchlists/:id/stocks/:symbol", requireAuth, validateObjectId("id"), async (req, res) => {
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

    router.post("/watchlists/:id/stocks/bulk-remove", requireAuth, validateObjectId("id"), async (req, res) => {
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

    return router;
}

module.exports = { createWatchlistRoutes };
