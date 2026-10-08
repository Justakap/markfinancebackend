const express = require("express");
const mongoose = require("mongoose");

function createBacktestRoutes({
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
}) {
    const router = express.Router();

    router.post("/backtest/run", requireAuth, backtestLimiter, async (req, res) => {
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

            if (strategyUsesPe(strategy)) {
                return res.status(400).json({
                    message:
                        "PE-based conditions are currently unavailable for historical backtesting because historical point-in-time PE data is not available. Remove the PE Ratio condition to run this backtest.",
                });
            }

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
                corporateActionsAdjusted: false,
                corporateActionsNote: CORPORATE_ACTIONS_NOTE,
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

    router.get("/backtests/:userId", requireAuth, async (req, res) => {
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

    router.get("/backtests/detail/:id", requireAuth, validateObjectId("id"), async (req, res) => {
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

    router.delete("/backtests/:id", requireAuth, validateObjectId("id"), async (req, res) => {
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

    return router;
}

module.exports = { createBacktestRoutes };
