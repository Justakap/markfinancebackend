const express = require("express");

// "Sufficiently fresh" for the initial anchor quote — reject creation
// rather than silently use a stale/cached price. Deliberately the same
// order of magnitude as the realtime module's own staleness threshold
// (services/gridSimulatorRealtime.js) for consistency, not coupled to it.
const QUOTE_FRESHNESS_MS = Number(process.env.GRID_SIMULATOR_QUOTE_FRESHNESS_MS || 15_000);

/**
 * Captures the immutable initial reference (R) from a fresh, validated
 * live quote — never a user-typed value. Actively warms the quote first
 * (the instrument may not be subscribed/pinned by anything yet for a
 * brand-new session), then requires a genuinely recent timestamp. Returns
 * null (never throws) when no sufficiently fresh quote is available —
 * the caller rejects session creation rather than silently falling back
 * to a stale cached price.
 */
async function captureFreshReference(marketDataService, instrumentKey) {
    await marketDataService.warmLiveQuotes([instrumentKey]).catch(() => {});
    const live = marketDataService.liveData.get(instrumentKey);
    if (!live || !Number.isFinite(Number(live.ltp)) || Number(live.ltp) <= 0) return null;
    if (!live.timestamp || Date.now() - Number(live.timestamp) > QUOTE_FRESHNESS_MS) return null;
    return { price: Number(live.ltp), capturedAt: new Date(live.timestamp) };
}

/**
 * Grid Trading Simulator — PAPER TRADING ONLY. Authenticated API for
 * configuring, running, and inspecting a simulated grid-trading session.
 * Nothing in this file (or anything it calls) places a real broker order —
 * "start"/"resume" only ever resume simulated evaluation, driven entirely
 * by genuine Upstox WebSocket ticks (services/gridSimulatorRealtime.js),
 * which funnels into services/gridSimulatorService.processTick (ADR-022).
 *
 * This route's `/tick` endpoint is display-only (ADR-028) — a client-
 * relayed price is NEVER fed into the authoritative crossing engine. See
 * that route's own doc comment for why.
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

function sessionDetail(session, getPortfolioMetrics, tradeCounts = null) {
    const currentPrice = session.lastFeedPrice ?? session.state.lastPrice ?? null;
    return {
        ...sessionSummary(session),
        state: {
            lastPrice: session.state.lastPrice,
            activeReference: session.state.activeReference ?? session.config.referencePrice,
            lastEventTimestamp: session.state.lastEventTimestamp,
            sequence: session.state.sequence,
        },
        portfolio: getPortfolioMetrics(session, currentPrice),
        tradeCounts,
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
    marketDataService,
    createSession,
    getOwnedSession,
    startSession,
    pauseSession,
    resumeSession,
    stopSession,
    listSessions,
    listTrades,
    getTradeCounts,
    getPortfolioMetrics,
    registerRealtimeSession = () => {},
    unregisterRealtimeSession = () => {},
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
                gridInterval,
                quantityPerLevel,
                startingCapital,
                maxPositionSize,
                commissionPct,
                slippagePct,
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

            // The initial reference is ALWAYS a fresh, server-captured live
            // quote — any client-supplied reference price is ignored.
            // Reject creation outright rather than silently fall back to a
            // stale/cached price.
            const freshQuote = await captureFreshReference(marketDataService, instrumentKey);
            if (!freshQuote) {
                return res.status(400).json({
                    message: "No sufficiently fresh market quote is available for this instrument right now. Try again in a moment.",
                });
            }

            const session = await createSession({
                GridSimulatorSession,
                userId: req.user.mongoId,
                instrumentKey,
                symbol: symbol || bodyInstrumentKey,
                config: {
                    referencePrice: freshQuote.price,
                    referenceCapturedAt: freshQuote.capturedAt,
                    gridInterval: Number(gridInterval),
                    quantityPerLevel: Number(quantityPerLevel),
                    startingCapital: Number(startingCapital),
                    maxPositionSize: maxPositionSize != null ? Number(maxPositionSize) : null,
                    commissionPct: commissionPct != null ? Number(commissionPct) : 0,
                    slippagePct: slippagePct != null ? Number(slippagePct) : 0,
                    startingHoldings: holdings,
                    startingAvgCost: holdings > 0 ? Number(startingAvgCost) : 0,
                },
            });

            return res.status(201).json({ session: sessionSummary(session) });
        } catch (error) {
            return handleError(res, error, "Failed to create grid simulator session");
        }
    });

    // After ACTIVE/PAUSED/STOPPED transitions, keep the real-time registry
    // (services/gridSimulatorRealtime.js — pins/unpins the instrument,
    // subscribes/unsubscribes this process to its live ticks) in sync with
    // the session's actual status. Same place watchlistRoutes.js calls
    // marketDataService.subscribe() directly after its own DB mutation —
    // routes already own this kind of side-effect orchestration here.
    function makeTransitionHandler(transitionFn, { afterActivate = false, afterDeactivate = false } = {}) {
        return async (req, res) => {
            try {
                const session = await transitionFn({ GridSimulatorSession, sessionId: req.params.sessionId, userId: req.user.mongoId });
                if (afterActivate) registerRealtimeSession(session);
                if (afterDeactivate) unregisterRealtimeSession(session._id);
                return res.json({ session: sessionSummary(session) });
            } catch (error) {
                return handleError(res, error, "Failed to update grid simulator session");
            }
        };
    }

    router.post("/v2/grid-simulator/sessions/:sessionId/start", requireAuth, validateObjectId("sessionId"), makeTransitionHandler(startSession, { afterActivate: true }));
    router.post("/v2/grid-simulator/sessions/:sessionId/pause", requireAuth, validateObjectId("sessionId"), makeTransitionHandler(pauseSession, { afterDeactivate: true }));
    router.post("/v2/grid-simulator/sessions/:sessionId/resume", requireAuth, validateObjectId("sessionId"), makeTransitionHandler(resumeSession, { afterActivate: true }));
    router.post("/v2/grid-simulator/sessions/:sessionId/stop", requireAuth, validateObjectId("sessionId"), makeTransitionHandler(stopSession, { afterDeactivate: true }));

    // Frontend-pushed tick: DISPLAY-ONLY (ADR-028). This used to be routed
    // into the same authoritative processTick() the real-time WS processor
    // uses, as a "lower-latency accelerant." That was unsafe: the browser
    // relays whatever price its own throttled Socket.IO subscription last
    // saw, which can be stale or out of true chronological order relative
    // to what services/gridSimulatorRealtime.js has already processed
    // directly from the genuine Upstox WebSocket feed. Since the engine's
    // dedup watermark only rejects a tick whose TIMESTAMP is <= the last
    // one processed (and this endpoint always server-stamps a fresh,
    // later timestamp), a stale client-relayed price was accepted as a
    // "genuine new price update" and could cross back through an
    // already-disarmed grid level in the opposite direction — re-arming
    // it, so the very next genuine WS tick re-fired the same BUY/SELL
    // signal again. This reproduced the exact "repeated SELL at the same
    // level, reason insufficient_holdings" symptom reported against the
    // live simulator. Fix: apply the same "only a genuine, backend-
    // verified source may be authoritative" rule ADR-023 already applies
    // to REST-fallback prices — a client-pushed price now only ever
    // updates feed-health display fields, never the crossing engine. The
    // backend's own event-driven WS processor is already fully sufficient
    // on its own (it keeps a session progressing with zero browser tabs
    // open at all), so this endpoint is no longer needed for correctness,
    // only kept for feed-health display continuity.
    router.post("/v2/grid-simulator/sessions/:sessionId/tick", requireAuth, validateObjectId("sessionId"), async (req, res) => {
        try {
            const { price } = req.body;
            if (!Number.isFinite(Number(price)) || Number(price) <= 0) {
                return res.status(400).json({ message: "price must be a positive number" });
            }

            const session = await getOwnedSession({ GridSimulatorSession, sessionId: req.params.sessionId, userId: req.user.mongoId });

            if (session.status === "ACTIVE") {
                await GridSimulatorSession.findOneAndUpdate(
                    { _id: session._id, status: "ACTIVE" },
                    { $set: { lastFeedCheckAt: new Date(), lastFeedPrice: Number(price) } },
                );
            }

            return res.json({ skipped: true, reason: "client_tick_display_only", trades: [] });
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
            const tradeCounts = await getTradeCounts({ GridSimulatorTrade, sessionId: req.params.sessionId });
            return res.json(sessionDetail(session, getPortfolioMetrics, tradeCounts));
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
