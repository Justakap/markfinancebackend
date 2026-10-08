const express = require("express");
const mongoose = require("mongoose");

/**
 * Phase F.5 — the professional system's own, cleanly separated backtest
 * API. Does NOT modify or reuse the legacy `/api/backtest/run` route
 * (routes/backtestRoutes.js, untouched) — StrategyDefinition/
 * StrategyVersion/BacktestResult/BacktestTrade are an entirely different
 * data model from the legacy Strategy/Backtest one, and mixing them into
 * one endpoint would blur exactly the separation ADR-006 established.
 *
 * Mirrors routes/optionChainRoutes.js's convention for mapping upstream
 * Upstox errors: our own credential/rate-limit problems are never
 * surfaced as a 401/403 to the client, since that would wrongly trip the
 * frontend's global handleUnauthorized() session-clearing interceptor for
 * an unrelated upstream problem.
 */
function mapUpstreamError(error) {
    const status = error?.response?.status;

    if (status === 429) {
        return { status: 429, message: "Too many requests to Upstox right now. Wait a moment and retry." };
    }
    if (status === 401 || status === 403) {
        return { status: 503, message: "Historical market data is temporarily unavailable. Please try again shortly." };
    }
    if (status >= 500 || !status) {
        return { status: 503, message: "Historical market data is temporarily unavailable. Please try again shortly." };
    }
    return { status: 502, message: "Failed to load historical market data." };
}

function isValidDate(value) {
    return value instanceof Date ? !Number.isNaN(value.getTime()) : !Number.isNaN(new Date(value).getTime());
}

function createProfessionalBacktestRoutes({
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
    DEFAULT_COMMISSION_PCT = 0.03,
    DEFAULT_SLIPPAGE_PCT = 0.05,
}) {
    const router = express.Router();

    router.post("/v2/backtest/run", requireAuth, backtestLimiter, async (req, res) => {
        try {
            const {
                strategyId,
                versionId,
                symbol,
                instrumentKey: bodyInstrumentKey,
                startDate,
                endDate,
                initialCapital = 10000,
                commissionPct = DEFAULT_COMMISSION_PCT,
                slippagePct = DEFAULT_SLIPPAGE_PCT,
            } = req.body;

            if (!mongoose.Types.ObjectId.isValid(strategyId)) {
                return res.status(400).json({ message: "Invalid identifier" });
            }
            if (versionId !== undefined && !mongoose.Types.ObjectId.isValid(versionId)) {
                return res.status(400).json({ message: "Invalid identifier" });
            }
            if (!symbol && !bodyInstrumentKey) {
                return res.status(400).json({ message: "symbol or instrumentKey is required" });
            }
            if (!startDate || !endDate || !isValidDate(startDate) || !isValidDate(endDate)) {
                return res.status(400).json({ message: "startDate and endDate must be valid dates" });
            }

            const start = new Date(startDate);
            const end = new Date(endDate);
            if (start >= end) {
                return res.status(400).json({ message: "startDate must be before endDate" });
            }
            if (end.getTime() > Date.now()) {
                return res.status(400).json({ message: "endDate cannot be in the future" });
            }
            if (!Number.isFinite(Number(initialCapital)) || Number(initialCapital) <= 0) {
                return res.status(400).json({ message: "initialCapital must be a positive number" });
            }

            // Ownership: the strategy must belong to the caller before we
            // trust ANY version id supplied against it — never resolve a
            // version by id alone without first confirming its parent
            // strategy's ownership.
            const strategy = await StrategyDefinition.findOne({ _id: strategyId, userId: req.user.mongoId });
            if (!strategy) {
                return res.status(404).json({ message: "Strategy not found" });
            }

            const targetVersionId = versionId || strategy.currentVersionId;
            if (!targetVersionId) {
                return res.status(400).json({ message: "This strategy has no saved version to run" });
            }

            const version = await StrategyVersion.findOne({ _id: targetVersionId, strategyId: strategy._id });
            if (!version) {
                return res.status(404).json({ message: "Strategy version not found" });
            }

            const instrumentKey = await resolveInstrumentKey(symbol, bodyInstrumentKey);
            if (!instrumentKey) {
                return res.status(400).json({
                    message: `No Upstox instrument found for ${symbol}. Search and pick a symbol from the list.`,
                });
            }

            const instrumentMeta = upstoxMarketData.getInstrumentMeta(instrumentKey);

            const { resultDoc, trades, dataQuality } = await runAndPersistBacktest({
                models: { BacktestResult, BacktestTrade },
                userId: req.user.mongoId,
                version,
                instrumentKey,
                symbol: symbol || bodyInstrumentKey,
                instrumentMeta,
                startDate: start,
                endDate: end,
                initialCapital: Number(initialCapital),
                commissionPct: Number(commissionPct),
                slippagePct: Number(slippagePct),
            });

            const TRADE_INLINE_LIMIT = 200;

            return res.status(201).json({
                backtestResultId: resultDoc._id,
                strategy: {
                    strategyId: strategy._id,
                    versionId: version._id,
                    versionNumber: version.versionNumber,
                    name: strategy.name,
                },
                instrument: { instrumentKey, symbol: resultDoc.symbol },
                timeframe: resultDoc.timeframe,
                dateRange: resultDoc.dateRange,
                initialCapital: resultDoc.initialCapital,
                configuration: {
                    executionConfig: resultDoc.executionConfig,
                    costConfig: resultDoc.costConfig,
                },
                summary: resultDoc.summary,
                equityCurve: resultDoc.equitySeries,
                tradeCount: trades.length,
                trades: trades.slice(0, TRADE_INLINE_LIMIT),
                tradesTruncated: trades.length > TRADE_INLINE_LIMIT,
                tradesEndpoint: `/api/v2/backtests/${resultDoc._id}/trades`,
                dataQuality,
            });
        } catch (error) {
            if (error.statusCode) {
                return res.status(error.statusCode).json({ message: error.clientMessage || error.message });
            }
            if (error?.response?.status) {
                const mapped = mapUpstreamError(error);
                return res.status(mapped.status).json({ message: mapped.message });
            }
            console.error("Professional backtest run error:", error);
            return res.status(500).json({ message: "Failed to run backtest" });
        }
    });

    router.get("/v2/backtests", requireAuth, async (req, res) => {
        try {
            const results = await BacktestResult.find({ userId: req.user.mongoId })
                .sort({ createdAt: -1 })
                .select("-equitySeries")
                .limit(100);

            return res.json(results);
        } catch (error) {
            console.error("List professional backtests error:", error);
            return res.status(500).json({ message: "Failed to list backtests" });
        }
    });

    router.get("/v2/backtests/:id", requireAuth, validateObjectId("id"), async (req, res) => {
        try {
            const result = await BacktestResult.findOne({ _id: req.params.id, userId: req.user.mongoId });
            if (!result) {
                return res.status(404).json({ message: "Backtest result not found" });
            }

            return res.json(result);
        } catch (error) {
            console.error("Get professional backtest error:", error);
            return res.status(500).json({ message: "Failed to fetch backtest" });
        }
    });

    router.get("/v2/backtests/:id/trades", requireAuth, validateObjectId("id"), async (req, res) => {
        try {
            const result = await BacktestResult.findOne({ _id: req.params.id, userId: req.user.mongoId });
            if (!result) {
                return res.status(404).json({ message: "Backtest result not found" });
            }

            const skip = Math.max(0, Number(req.query.skip) || 0);
            const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));

            const trades = await BacktestTrade.find({ backtestResultId: result._id })
                .sort({ entryDate: 1 })
                .skip(skip)
                .limit(limit);

            return res.json({ backtestResultId: result._id, skip, limit, total: result.tradeCount, trades });
        } catch (error) {
            console.error("List professional backtest trades error:", error);
            return res.status(500).json({ message: "Failed to fetch trades" });
        }
    });

    return router;
}

module.exports = { createProfessionalBacktestRoutes, mapUpstreamError };
