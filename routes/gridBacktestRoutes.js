const express = require("express");
const { fetchHistoricalRangeMaybeChunked } = require("../services/candleService");

/**
 * Grid Backtest — PAPER TRADING / HISTORICAL SIMULATION ONLY. Authenticated
 * API for configuring, running, and inspecting a historical grid-strategy
 * replay. Completely isolated from the live Grid Simulator's authoritative
 * execution path (ADR-027) — never pins a live instrument, never touches
 * marketDataService, never mutates a GridSimulatorSession.
 *
 * Own `/v2/grid-backtest` prefix — distinct from `/v2/grid-simulator`,
 * `/v2/strategies`, `/v2/backtest` (same ADR-006-style separation as every
 * other new model in this codebase).
 */

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

function parsePagination(query) {
    const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
    const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Number.parseInt(query.limit, 10) || DEFAULT_PAGE_SIZE));
    return { page, limit };
}

function backtestSummary(backtest) {
    return {
        backtestId: backtest._id,
        instrumentKey: backtest.instrumentKey,
        symbol: backtest.symbol,
        status: backtest.status,
        error: backtest.error,
        config: backtest.config,
        initialReference: backtest.initialReference,
        dataQuality: backtest.dataQuality,
        metrics: backtest.metrics,
        createdAt: backtest.createdAt,
        completedAt: backtest.completedAt,
    };
}

function backtestDetail(backtest) {
    return {
        ...backtestSummary(backtest),
        finalState: backtest.finalState,
        equitySeries: backtest.equitySeries,
    };
}

function tradeSummary(trade) {
    return {
        tradeId: trade._id,
        sequence: trade.sequence,
        type: trade.type,
        level: trade.level,
        levelPrice: trade.levelPrice,
        fillPrice: trade.fillPrice,
        qtyRequested: trade.qtyRequested,
        qtyFilled: trade.qtyFilled,
        qtySkipped: trade.qtySkipped,
        reason: trade.reason,
        cashAfter: trade.cashAfter,
        holdingsAfter: trade.holdingsAfter,
        avgCostAfter: trade.avgCostAfter,
        realizedPnLDelta: trade.realizedPnLDelta,
        gapFill: trade.gapFill,
        assumedIntrabar: trade.assumedIntrabar,
        isSimulated: trade.isSimulated,
        candleTimestamp: trade.candleTimestamp,
        eventTimestamp: trade.eventTimestamp,
    };
}

function createGridBacktestRoutes({
    GridBacktestResult,
    GridBacktestTrade,
    requireAuth,
    validateObjectId,
    resolveInstrumentKey,
    runGridBacktest,
    getOwnedBacktest,
    listBacktests,
    listBacktestTrades,
    fetchRange = fetchHistoricalRangeMaybeChunked,
}) {
    const router = express.Router();

    function handleError(res, error, fallbackMessage) {
        if (error.statusCode) {
            return res.status(error.statusCode).json({ message: error.clientMessage || error.message });
        }
        console.error(fallbackMessage, error);
        return res.status(500).json({ message: fallbackMessage });
    }

    router.post("/v2/grid-backtest/backtests", requireAuth, async (req, res) => {
        try {
            const {
                symbol,
                instrumentKey: bodyInstrumentKey,
                timeframe,
                requestedStartDate,
                requestedEndDate,
                gridInterval,
                quantityPerLevel,
                startingCapital,
                maxPositionSize,
                startingHoldings,
                startingAvgCost,
            } = req.body;

            if (!symbol && !bodyInstrumentKey) {
                return res.status(400).json({ message: "symbol or instrumentKey is required" });
            }

            const holdings = startingHoldings != null ? Number(startingHoldings) : 0;
            if (holdings > 0 && !(Number.isFinite(Number(startingAvgCost)) && Number(startingAvgCost) > 0)) {
                return res.status(400).json({ message: "startingAvgCost is required and must be a positive number when startingHoldings > 0" });
            }

            const instrumentKey = await resolveInstrumentKey(symbol, bodyInstrumentKey);
            if (!instrumentKey) {
                return res.status(400).json({
                    message: `No Upstox instrument found for ${symbol}. Search and pick a symbol from the list.`,
                });
            }

            const backtest = await runGridBacktest({
                GridBacktestResult,
                GridBacktestTrade,
                userId: req.user.mongoId,
                instrumentKey,
                symbol: symbol || bodyInstrumentKey,
                timeframe,
                requestedStartDate,
                requestedEndDate,
                config: {
                    gridInterval: Number(gridInterval),
                    quantityPerLevel: Number(quantityPerLevel),
                    startingCapital: Number(startingCapital),
                    maxPositionSize: maxPositionSize != null ? Number(maxPositionSize) : null,
                    startingHoldings: holdings,
                    startingAvgCost: holdings > 0 ? Number(startingAvgCost) : 0,
                },
                fetchRange,
            });

            return res.status(201).json({ backtest: backtestDetail(backtest) });
        } catch (error) {
            return handleError(res, error, "Failed to run grid backtest");
        }
    });

    router.get("/v2/grid-backtest/backtests", requireAuth, async (req, res) => {
        try {
            const { page, limit } = parsePagination(req.query);
            const { items, total } = await listBacktests({ GridBacktestResult, userId: req.user.mongoId, page, limit });
            return res.json({ items: items.map(backtestSummary), page, limit, total });
        } catch (error) {
            return handleError(res, error, "Failed to list grid backtests");
        }
    });

    router.get("/v2/grid-backtest/backtests/:backtestId", requireAuth, validateObjectId("backtestId"), async (req, res) => {
        try {
            const backtest = await getOwnedBacktest({ GridBacktestResult, backtestId: req.params.backtestId, userId: req.user.mongoId });
            return res.json(backtestDetail(backtest));
        } catch (error) {
            return handleError(res, error, "Failed to fetch grid backtest");
        }
    });

    router.get("/v2/grid-backtest/backtests/:backtestId/trades", requireAuth, validateObjectId("backtestId"), async (req, res) => {
        try {
            await getOwnedBacktest({ GridBacktestResult, backtestId: req.params.backtestId, userId: req.user.mongoId });
            const { page, limit } = parsePagination(req.query);
            const { items, total } = await listBacktestTrades({ GridBacktestTrade, backtestId: req.params.backtestId, page, limit });
            return res.json({ items: items.map(tradeSummary), page, limit, total });
        } catch (error) {
            return handleError(res, error, "Failed to fetch grid backtest trades");
        }
    });

    return router;
}

module.exports = { createGridBacktestRoutes };
