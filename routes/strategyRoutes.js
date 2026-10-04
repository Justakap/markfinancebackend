const express = require("express");
const mongoose = require("mongoose");

function createStrategyRoutes({
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
}) {
    const router = express.Router();

    // run strategy
    router.post("/strategies/run", requireAuth, async (req, res) => {
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

    // Strategy
    router.post("/strategies", requireAuth, async (req, res) => {
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

    router.get("/strategies/:userId", requireAuth, async (req, res) => {
        try {
            if (req.user.mongoId !== req.params.userId) return res.status(403).json({ message: "Forbidden" });

            const strategies = await Strategy.find({ userId: req.user.mongoId }).sort({ createdAt: -1 });

            res.json(strategies);
        } catch (error) {
            console.error("List strategies error:", error);
            res.status(500).json({ message: "Failed to fetch strategies" });
        }
    });

    router.put("/strategies/:id", requireAuth, validateObjectId("id"), async (req, res) => {
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

    router.post("/strategies/seed-samples", requireAuth, async (req, res) => {
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

    router.delete("/strategies/:id", requireAuth, validateObjectId("id"), async (req, res) => {
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

    router.get("/strategy-details/:id", requireAuth, validateObjectId("id"), async (req, res) => {
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

    return router;
}

module.exports = { createStrategyRoutes };
