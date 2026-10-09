const express = require("express");
const mongoose = require("mongoose");

/**
 * Workstream J — authenticated API for activating/deactivating a
 * professional strategy's live evaluation and inspecting its simulated
 * position/signal history. Deliberately separate from both the legacy
 * `/api/strategies`/`/api/backtest` routes and the professional
 * `/api/v2/strategies`/`/api/v2/backtest` routes (own `/v2/live` prefix) —
 * same reasoning as every prior ADR-006-style separation in this
 * codebase: a distinct data model (LiveStrategyRuntime/LiveStrategySignal)
 * deserves its own endpoint, not a shared/branching one.
 *
 * No real order execution anywhere in this file — "activate" only ever
 * starts simulated evaluation (services/liveStrategyOrchestrator.js).
 */

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const VALID_TIMEFRAMES = ["1m", "5m", "15m", "1h", "1d"];

function parsePagination(query) {
    const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
    const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Number.parseInt(query.limit, 10) || DEFAULT_PAGE_SIZE));
    return { page, limit, skip: (page - 1) * limit };
}

function runtimeSummary(runtime) {
    return {
        runtimeId: runtime._id,
        strategyId: runtime.strategyId,
        strategyVersionId: runtime.strategyVersionId,
        instrumentKey: runtime.instrumentKey,
        symbol: runtime.symbol,
        timeframe: runtime.timeframe,
        status: runtime.status,
        config: runtime.config,
        createdAt: runtime.createdAt,
        deactivatedAt: runtime.deactivatedAt,
    };
}

/** Includes the live position/evaluation detail a summary omits — used by
 *  the single-runtime status endpoint, not the list endpoint, so listing
 *  many runtimes stays a cheap query. */
function runtimeStatusDetail(runtime) {
    return {
        ...runtimeSummary(runtime),
        position: runtime.engineState.inPosition
            ? {
                  entryPrice: runtime.engineState.entryPrice,
                  entryDate: runtime.engineState.entryDate,
                  quantity: runtime.engineState.quantity,
              }
            : null,
        pendingEntry: runtime.engineState.pendingEntry,
        pendingExit: runtime.engineState.pendingExit,
        pendingExitReason: runtime.engineState.pendingExitReason,
        equity: runtime.engineState.equity,
        peakEquity: runtime.engineState.peakEquity,
        barsProcessed: runtime.engineState.barsProcessed,
        lastProcessedCandleTimestamp: runtime.lastProcessedCandleTimestamp,
        lastEvaluationAt: runtime.lastEvaluationAt,
        lastEvaluationStatus: runtime.lastEvaluationStatus,
    };
}

function signalSummary(signal) {
    return {
        signalId: signal._id,
        type: signal.type,
        barDate: signal.barDate,
        price: signal.price,
        quantity: signal.quantity,
        exitReason: signal.exitReason,
        entryPrice: signal.entryPrice,
        entryDate: signal.entryDate,
        grossPnl: signal.grossPnl,
        fees: signal.fees,
        slippageCost: signal.slippageCost,
        netPnl: signal.netPnl,
        returnPct: signal.returnPct,
        holdingPeriodBars: signal.holdingPeriodBars,
        createdAt: signal.createdAt,
    };
}

function createLiveStrategyRoutes({
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
    DEFAULT_COMMISSION_PCT = 0.03,
    DEFAULT_SLIPPAGE_PCT = 0.05,
}) {
    const router = express.Router();

    router.post("/v2/live/activate", requireAuth, liveStrategyLimiter, async (req, res) => {
        try {
            const {
                strategyId,
                versionId,
                symbol,
                instrumentKey: bodyInstrumentKey,
                timeframe,
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
            if (!VALID_TIMEFRAMES.includes(timeframe)) {
                return res.status(400).json({ message: `timeframe must be one of ${VALID_TIMEFRAMES.join(", ")}` });
            }
            if (!Number.isFinite(Number(initialCapital)) || Number(initialCapital) <= 0) {
                return res.status(400).json({ message: "initialCapital must be a positive number" });
            }

            const instrumentKey = await resolveInstrumentKey(symbol, bodyInstrumentKey);
            if (!instrumentKey) {
                return res.status(400).json({
                    message: `No Upstox instrument found for ${symbol}. Search and pick a symbol from the list.`,
                });
            }

            const { runtime } = await activateLiveStrategy({
                models: { StrategyDefinition, StrategyVersion, LiveStrategyRuntime },
                userId: req.user.mongoId,
                strategyId,
                strategyVersionId: versionId,
                instrumentKey,
                symbol: symbol || bodyInstrumentKey,
                timeframe,
                initialCapital: Number(initialCapital),
                commissionPct: Number(commissionPct),
                slippagePct: Number(slippagePct),
            });

            return res.status(201).json({ runtime: runtimeSummary(runtime) });
        } catch (error) {
            if (error.statusCode) {
                return res.status(error.statusCode).json({ message: error.clientMessage || error.message });
            }
            console.error("Activate live strategy error:", error);
            return res.status(500).json({ message: "Failed to activate live strategy" });
        }
    });

    router.post("/v2/live/:runtimeId/deactivate", requireAuth, liveStrategyLimiter, validateObjectId("runtimeId"), async (req, res) => {
        try {
            const runtime = await deactivateLiveStrategy({
                models: { LiveStrategyRuntime },
                userId: req.user.mongoId,
                runtimeId: req.params.runtimeId,
            });
            return res.json({ runtime: runtimeSummary(runtime) });
        } catch (error) {
            if (error.statusCode) {
                return res.status(error.statusCode).json({ message: error.clientMessage || error.message });
            }
            console.error("Deactivate live strategy error:", error);
            return res.status(500).json({ message: "Failed to deactivate live strategy" });
        }
    });

    router.get("/v2/live", requireAuth, async (req, res) => {
        try {
            const { page, limit, skip } = parsePagination(req.query);
            const filter = { userId: req.user.mongoId };
            if (req.query.status === "ACTIVE" || req.query.status === "INACTIVE") {
                filter.status = req.query.status;
            }

            const [items, total] = await Promise.all([
                LiveStrategyRuntime.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
                LiveStrategyRuntime.countDocuments(filter),
            ]);

            return res.json({ items: items.map(runtimeSummary), page, limit, total });
        } catch (error) {
            console.error("List live strategies error:", error);
            return res.status(500).json({ message: "Failed to list live strategies" });
        }
    });

    router.get("/v2/live/:runtimeId", requireAuth, validateObjectId("runtimeId"), async (req, res) => {
        try {
            const runtime = await LiveStrategyRuntime.findOne({ _id: req.params.runtimeId, userId: req.user.mongoId });
            if (!runtime) {
                return res.status(404).json({ message: "Live strategy runtime not found" });
            }
            return res.json(runtimeStatusDetail(runtime));
        } catch (error) {
            console.error("Get live strategy status error:", error);
            return res.status(500).json({ message: "Failed to fetch live strategy status" });
        }
    });

    router.get("/v2/live/:runtimeId/signals", requireAuth, validateObjectId("runtimeId"), async (req, res) => {
        try {
            const runtime = await LiveStrategyRuntime.findOne({ _id: req.params.runtimeId, userId: req.user.mongoId });
            if (!runtime) {
                return res.status(404).json({ message: "Live strategy runtime not found" });
            }

            const { page, limit, skip } = parsePagination(req.query);
            const filter = { runtimeId: runtime._id };

            const [items, total] = await Promise.all([
                LiveStrategySignal.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
                LiveStrategySignal.countDocuments(filter),
            ]);

            return res.json({ items: items.map(signalSummary), page, limit, total });
        } catch (error) {
            console.error("List live strategy signals error:", error);
            return res.status(500).json({ message: "Failed to fetch live strategy signals" });
        }
    });

    return router;
}

module.exports = { createLiveStrategyRoutes, VALID_TIMEFRAMES };
