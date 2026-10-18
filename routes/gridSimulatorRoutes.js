const express = require("express");

/**
 * Grid Trading Simulator — PAPER TRADING ONLY. Authenticated API for
 * configuring, running, and inspecting a simulated grid-trading session.
 * Nothing in this file (or anything it calls) places a real broker order —
 * "start"/"resume" only ever resume simulated evaluation
 * (services/gridSimulatorFeed.js's poll loop + this route's own tick
 * endpoint, both funneling into services/gridSimulatorService.processTick).
 *
 * Own `/v2/grid-simulator` prefix — distinct from `/v2/strategies`,
 * `/v2/backtest`, `/v2/live`, `/v2/alert-configurations` (same
 * reasoning as every prior ADR-006-style separation in this codebase).
 */

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

function parsePagination(query) {
    const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
    const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Number.parseInt(query.limit, 10) || DEFAULT_PAGE_SIZE));
    return { page, limit, skip: (page - 1) * limit };
}

function sessionSummary(session) {
    return {
        sessionId: session._id,
        instrumentKey: session.instrumentKey,
        symbol: session.symbol,
        status: session.status,
        config: session.config,
        createdAt: session.createdAt,
        startedAt: session.startedAt,
        stoppedAt: session.stoppedAt,
        lastFeedStatus: session.lastFeedStatus,
        lastFeedCheckAt: session.lastFeedCheckAt,
        lastFeedPrice: session.lastFeedPrice,
    };
}

function sessionDetail(session, getPortfolioMetrics) {
    const currentPrice = session.lastFeedPrice ?? session.state.lastPrice ?? null;
    return {
        ...sessionSummary(session),
        state: {
            lastPrice: session.state.lastPrice,
            lastEventTimestamp: session.state.lastEventTimestamp,
            sequence: session.state.sequence,
        },
        portfolio: getPortfolioMetrics(session, currentPrice),
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
        effectivePrice: trade.effectivePrice,
        qtyRequested: trade.qtyRequested,
        qtyFilled: trade.qtyFilled,
        qtySkipped: trade.qtySkipped,
        reason: trade.reason,
        cashAfter: trade.cashAfter,
        holdingsAfter: trade.holdingsAfter,
        avgCostAfter: trade.avgCostAfter,
        realizedPnLDelta: trade.realizedPnLDelta,
        gapFill: trade.gapFill,
        isSimulated: trade.isSimulated,
        eventTimestamp: trade.eventTimestamp,
        createdAt: trade.createdAt,
    };
}

function createGridSimulatorRoutes({
    GridSimulatorSession,
    GridSimulatorTrade,
    requireAuth,
    validateObjectId,
    resolveInstrumentKey,
    createSession,
    getOwnedSession,
    startSession,
    pauseSession,
    resumeSession,
    stopSession,
    processTick,
    listSessions,
    listTrades,
    getPortfolioMetrics,
}) {
    const router = express.Router();

    function handleError(res, error, fallbackMessage) {
        if (error.statusCode) {
            return res.status(error.statusCode).json({ message: error.clientMessage || error.message });
        }
        console.error(fallbackMessage, error);
        return res.status(500).json({ message: fallbackMessage });
    }

    router.post("/v2/grid-simulator/sessions", requireAuth, async (req, res) => {
        try {
            const {
                symbol,
                instrumentKey: bodyInstrumentKey,
                referencePrice,
                gridInterval,
                quantityPerLevel,
                startingCapital,
                maxPositionSize,
                commissionPct,
                slippagePct,
            } = req.body;

            if (!symbol && !bodyInstrumentKey) {
                return res.status(400).json({ message: "symbol or instrumentKey is required" });
            }

            const instrumentKey = await resolveInstrumentKey(symbol, bodyInstrumentKey);
            if (!instrumentKey) {
                return res.status(400).json({
                    message: `No Upstox instrument found for ${symbol}. Search and pick a symbol from the list.`,
                });
            }

            const session = await createSession({
                GridSimulatorSession,
                userId: req.user.mongoId,
                instrumentKey,
                symbol: symbol || bodyInstrumentKey,
                config: {
                    referencePrice: Number(referencePrice),
                    gridInterval: Number(gridInterval),
                    quantityPerLevel: Number(quantityPerLevel),
                    startingCapital: Number(startingCapital),
                    maxPositionSize: maxPositionSize != null ? Number(maxPositionSize) : null,
                    commissionPct: commissionPct != null ? Number(commissionPct) : 0,
                    slippagePct: slippagePct != null ? Number(slippagePct) : 0,
                },
            });

            return res.status(201).json({ session: sessionSummary(session) });
        } catch (error) {
            return handleError(res, error, "Failed to create grid simulator session");
        }
    });

    function makeTransitionHandler(transitionFn) {
        return async (req, res) => {
            try {
                const session = await transitionFn({ GridSimulatorSession, sessionId: req.params.sessionId, userId: req.user.mongoId });
                return res.json({ session: sessionSummary(session) });
            } catch (error) {
                return handleError(res, error, "Failed to update grid simulator session");
            }
        };
    }

    router.post("/v2/grid-simulator/sessions/:sessionId/start", requireAuth, validateObjectId("sessionId"), makeTransitionHandler(startSession));
    router.post("/v2/grid-simulator/sessions/:sessionId/pause", requireAuth, validateObjectId("sessionId"), makeTransitionHandler(pauseSession));
    router.post("/v2/grid-simulator/sessions/:sessionId/resume", requireAuth, validateObjectId("sessionId"), makeTransitionHandler(resumeSession));
    router.post("/v2/grid-simulator/sessions/:sessionId/stop", requireAuth, validateObjectId("sessionId"), makeTransitionHandler(stopSession));

    // Frontend-pushed tick: lets the browser's own already-open Socket.IO
    // `marketTick` subscription drive lower-latency updates than the
    // backend's own poll loop (services/gridSimulatorFeed.js), which remains
    // the fallback that keeps the session progressing even with no tab open.
    // Both paths funnel into the exact same idempotent processTick.
    router.post("/v2/grid-simulator/sessions/:sessionId/tick", requireAuth, validateObjectId("sessionId"), async (req, res) => {
        try {
            const { price, eventTimestamp } = req.body;
            if (!Number.isFinite(Number(price)) || Number(price) <= 0) {
                return res.status(400).json({ message: "price must be a positive number" });
            }
            const timestamp = eventTimestamp && !Number.isNaN(new Date(eventTimestamp).getTime()) ? eventTimestamp : new Date().toISOString();

            await getOwnedSession({ GridSimulatorSession, sessionId: req.params.sessionId, userId: req.user.mongoId });
            const result = await processTick({
                GridSimulatorSession,
                GridSimulatorTrade,
                sessionId: req.params.sessionId,
                price: Number(price),
                eventTimestamp: timestamp,
            });
            return res.json({ skipped: result.skipped, reason: result.reason || null, trades: (result.trades || []).map(tradeSummary) });
        } catch (error) {
            return handleError(res, error, "Failed to process grid simulator tick");
        }
    });

    router.get("/v2/grid-simulator/sessions", requireAuth, async (req, res) => {
        try {
            const { page, limit } = parsePagination(req.query);
            const status = ["CREATED", "ACTIVE", "PAUSED", "STOPPED"].includes(req.query.status) ? req.query.status : undefined;
            const { items, total } = await listSessions({ GridSimulatorSession, userId: req.user.mongoId, page, limit, status });
            return res.json({ items: items.map(sessionSummary), page, limit, total });
        } catch (error) {
            return handleError(res, error, "Failed to list grid simulator sessions");
        }
    });

    router.get("/v2/grid-simulator/sessions/:sessionId", requireAuth, validateObjectId("sessionId"), async (req, res) => {
        try {
            const session = await getOwnedSession({ GridSimulatorSession, sessionId: req.params.sessionId, userId: req.user.mongoId });
            return res.json(sessionDetail(session, getPortfolioMetrics));
        } catch (error) {
            return handleError(res, error, "Failed to fetch grid simulator session");
        }
    });

    router.get("/v2/grid-simulator/sessions/:sessionId/trades", requireAuth, validateObjectId("sessionId"), async (req, res) => {
        try {
            await getOwnedSession({ GridSimulatorSession, sessionId: req.params.sessionId, userId: req.user.mongoId });
            const { page, limit } = parsePagination(req.query);
            const skippedOnly = req.query.skippedOnly === "true";
            const { items, total } = await listTrades({ GridSimulatorTrade, sessionId: req.params.sessionId, page, limit, skippedOnly });
            return res.json({ items: items.map(tradeSummary), page, limit, total });
        } catch (error) {
            return handleError(res, error, "Failed to fetch grid simulator trades");
        }
    });

    return router;
}

module.exports = { createGridSimulatorRoutes };
