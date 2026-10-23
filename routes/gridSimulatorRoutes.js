const express = require("express");
const { classifySegmentClass } = require("../services/gridChargesCalculator");
const { nearestPendingLevels } = require("../services/gridSimulatorService");

// "Sufficiently fresh" for the initial anchor quote — reject starting
// (ADR-038: captured at Start, not creation) rather than silently use a
// stale/cached price. Deliberately the same order of magnitude as the
// realtime module's own staleness threshold (services/
// gridSimulatorRealtime.js) for consistency, not coupled to it.
const QUOTE_FRESHNESS_MS = Number(process.env.GRID_SIMULATOR_QUOTE_FRESHNESS_MS || 15_000);

/**
 * Captures the immutable initial reference (R) from a fresh, validated
 * live quote — never a user-typed value. Actively warms the quote first
 * (the instrument may not be subscribed/pinned by anything yet, since a
 * CREATED-but-not-started session was never pinned). Returns null (never
 * throws) when no sufficiently fresh quote is available — the caller
 * rejects starting the session rather than silently falling back to a
 * stale cached price.
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

function sessionDetail(session, getPortfolioMetrics, tradeCounts = null, charges = null) {
    const currentPrice = session.lastFeedPrice ?? session.state.lastPrice ?? null;
    return {
        ...sessionSummary(session),
        state: {
            lastPrice: session.state.lastPrice,
            ...nearestPendingLevels({ state: session.state, config: session.config }),
            lastEventTimestamp: session.state.lastEventTimestamp,
            sequence: session.state.sequence,
        },
        portfolio: getPortfolioMetrics(session, currentPrice),
        tradeCounts,
        charges,
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
    startSessionWithInitialBuy,
    pauseSession,
    resumeSession,
    stopSession,
    listSessions,
    listTrades,
    getTradeCounts,
    getChargesSummary,
    updateSessionConfig,
    deleteSession,
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
                sellVariance,
                quantityPerLevel,
                sellQuantityPerLevel,
                startingCapital,
                maxPositionSize,
                startingHoldings,
                startingAvgCost,
                usePriceLimits,
                lowerLimit,
                upperLimit,
            } = req.body;

            if (!symbol && !bodyInstrumentKey) {
                return res.status(400).json({ message: "symbol or instrumentKey is required" });
            }

            const holdings = startingHoldings != null ? Number(startingHoldings) : 0;
            if (holdings > 0 && !(Number.isFinite(Number(startingAvgCost)) && Number(startingAvgCost) > 0)) {
                return res.status(400).json({ message: "startingAvgCost is required and must be a positive number when startingHoldings > 0" });
            }
            if (sellVariance != null && !(Number.isFinite(Number(sellVariance)) && Number(sellVariance) > 0)) {
                return res.status(400).json({ message: "sellVariance must be a positive number when provided" });
            }
            if (sellQuantityPerLevel != null && !(Number.isInteger(Number(sellQuantityPerLevel)) && Number(sellQuantityPerLevel) > 0)) {
                return res.status(400).json({ message: "sellQuantityPerLevel must be a positive integer when provided" });
            }

            // ADR-040: optional price band — require both bounds, as positive
            // numbers with upperLimit > lowerLimit, whenever the client opts
            // in via usePriceLimits. Never silently accept a half-specified
            // or inverted band.
            let normalizedLowerLimit = null;
            let normalizedUpperLimit = null;
            if (usePriceLimits) {
                if (!(Number.isFinite(Number(lowerLimit)) && Number(lowerLimit) > 0) || !(Number.isFinite(Number(upperLimit)) && Number(upperLimit) > 0)) {
                    return res.status(400).json({ message: "Both an Upper Limit and a Lower Limit are required and must be positive numbers when price limits are enabled" });
                }
                if (Number(upperLimit) <= Number(lowerLimit)) {
                    return res.status(400).json({ message: "Upper Limit must be greater than Lower Limit" });
                }
                normalizedLowerLimit = Number(lowerLimit);
                normalizedUpperLimit = Number(upperLimit);
            }

            const instrumentKey = await resolveInstrumentKey(symbol, bodyInstrumentKey);
            if (!instrumentKey) {
                return res.status(400).json({
                    message: `No Upstox instrument found for ${symbol}. Search and pick a symbol from the list.`,
                });
            }

            // ADR-038: the initial reference is NOT captured here anymore —
            // it's captured the moment the user clicks Start (see the
            // /start route below). A client-supplied reference price is
            // still ignored either way, never trusted.

            // Immutable (ADR-035), captured once here from the resolved
            // instrument's own type/segment — drives the display-only
            // charges estimate, never re-derived or editable afterward.
            // This doesn't need a live quote, only the instrument's static
            // type/segment metadata, so it's independent of ADR-038's
            // reference-at-start change.
            const segmentClass = classifySegmentClass(marketDataService.getInstrumentMeta?.(instrumentKey));

            const session = await createSession({
                GridSimulatorSession,
                userId: req.user.mongoId,
                instrumentKey,
                symbol: symbol || bodyInstrumentKey,
                config: {
                    gridInterval: Number(gridInterval),
                    sellVariance: sellVariance != null ? Number(sellVariance) : null,
                    quantityPerLevel: Number(quantityPerLevel),
                    sellQuantityPerLevel: sellQuantityPerLevel != null ? Number(sellQuantityPerLevel) : null,
                    startingCapital: Number(startingCapital),
                    maxPositionSize: maxPositionSize != null ? Number(maxPositionSize) : null,
                    startingHoldings: holdings,
                    startingAvgCost: holdings > 0 ? Number(startingAvgCost) : 0,
                    lowerLimit: normalizedLowerLimit,
                    upperLimit: normalizedUpperLimit,
                    segmentClass,
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

    // ADR-038: Start is the ONLY path that captures the reference price —
    // right now, from a fresh live quote — and immediately executes one
    // real BUY fill at that exact price. Resume (below) is a completely
    // separate, unchanged path for a PAUSED session; it never re-captures
    // a reference or re-buys.
    router.post("/v2/grid-simulator/sessions/:sessionId/start", requireAuth, validateObjectId("sessionId"), async (req, res) => {
        try {
            const session = await getOwnedSession({ GridSimulatorSession, sessionId: req.params.sessionId, userId: req.user.mongoId });
            if (session.status !== "CREATED") {
                return res.status(409).json({ message: `Cannot start from its current state (${session.status})` });
            }

            const freshQuote = await captureFreshReference(marketDataService, session.instrumentKey);
            if (!freshQuote) {
                return res.status(400).json({
                    message: "No sufficiently fresh market quote is available for this instrument right now. Try again in a moment.",
                });
            }

            const updated = await startSessionWithInitialBuy({
                GridSimulatorSession,
                GridSimulatorTrade,
                sessionId: session._id,
                userId: req.user.mongoId,
                referencePrice: freshQuote.price,
                referenceCapturedAt: freshQuote.capturedAt,
            });
            registerRealtimeSession(updated);
            return res.json({ session: sessionSummary(updated) });
        } catch (error) {
            return handleError(res, error, "Failed to start grid simulator session");
        }
    });
    // Read-only live-quote preview for a session that hasn't been started
    // yet (CREATED) — lets the UI show a live price before the user clicks
    // Start, without capturing/persisting anything. Reuses the exact same
    // captureFreshReference() helper Start itself uses, so "the price you
    // see here" and "the price Start will actually buy at" are guaranteed
    // to come from the same provenance/freshness check — just never
    // written anywhere. Works for any status, not only CREATED, since it
    // has no side effects worth restricting.
    router.get("/v2/grid-simulator/sessions/:sessionId/preview-quote", requireAuth, validateObjectId("sessionId"), async (req, res) => {
        try {
            const session = await getOwnedSession({ GridSimulatorSession, sessionId: req.params.sessionId, userId: req.user.mongoId });
            const freshQuote = await captureFreshReference(marketDataService, session.instrumentKey);
            if (!freshQuote) {
                return res.status(404).json({ message: "No live quote is currently available for this instrument." });
            }
            return res.json({ price: freshQuote.price, capturedAt: freshQuote.capturedAt });
        } catch (error) {
            return handleError(res, error, "Failed to fetch live quote preview");
        }
    });

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

    // Live-editable config (ADR-034) — quantityPerLevel, gridInterval ("Buy
    // Variance"), sellVariance, and a cash top-up. Restricted to PAUSED
    // sessions only (see updateSessionConfig's doc comment) — enforced in
    // the service layer via the status-scoped findOneAndUpdate, not just
    // here, so a concurrent resume can't race past this check.
    router.patch("/v2/grid-simulator/sessions/:sessionId/config", requireAuth, validateObjectId("sessionId"), async (req, res) => {
        try {
            const { quantityPerLevel, gridInterval, useSeparateSellVariance, sellVariance, useSeparateSellQuantity, sellQuantityPerLevel, addCash } = req.body;
            const patch = {};

            if (quantityPerLevel != null) {
                if (!Number.isInteger(Number(quantityPerLevel)) || Number(quantityPerLevel) < 1) {
                    return res.status(400).json({ message: "quantityPerLevel must be a positive integer" });
                }
                patch.quantityPerLevel = Number(quantityPerLevel);
            }

            if (gridInterval != null) {
                if (!Number.isFinite(Number(gridInterval)) || Number(gridInterval) <= 0) {
                    return res.status(400).json({ message: "gridInterval must be a positive number" });
                }
                patch.gridInterval = Number(gridInterval);
            }

            if (useSeparateSellVariance === true) {
                if (!Number.isFinite(Number(sellVariance)) || Number(sellVariance) <= 0) {
                    return res.status(400).json({ message: "sellVariance must be a positive number when using a separate sell variance" });
                }
                patch.sellVariance = Number(sellVariance);
            } else if (useSeparateSellVariance === false) {
                patch.sellVariance = null; // mirror the (possibly also-updated) buy variance
            }

            if (useSeparateSellQuantity === true) {
                if (!Number.isInteger(Number(sellQuantityPerLevel)) || Number(sellQuantityPerLevel) < 1) {
                    return res.status(400).json({ message: "sellQuantityPerLevel must be a positive integer when using a separate sell quantity" });
                }
                patch.sellQuantityPerLevel = Number(sellQuantityPerLevel);
            } else if (useSeparateSellQuantity === false) {
                patch.sellQuantityPerLevel = null; // mirror the (possibly also-updated) buy quantity
            }

            if (addCash != null) {
                if (!Number.isFinite(Number(addCash)) || Number(addCash) <= 0) {
                    return res.status(400).json({ message: "addCash must be a positive number" });
                }
                patch.addCash = Number(addCash);
            }

            const updated = await updateSessionConfig({ GridSimulatorSession, sessionId: req.params.sessionId, userId: req.user.mongoId, patch });
            return res.json({ session: sessionSummary(updated) });
        } catch (error) {
            return handleError(res, error, "Failed to update grid simulator session configuration");
        }
    });

    // Deletable regardless of status — an ACTIVE/PAUSED session is first
    // unregistered from the real-time registry (releases its instrument
    // pin, stops any further tick from targeting it) before its document
    // and trade ledger are removed.
    router.delete("/v2/grid-simulator/sessions/:sessionId", requireAuth, validateObjectId("sessionId"), async (req, res) => {
        try {
            const session = await getOwnedSession({ GridSimulatorSession, sessionId: req.params.sessionId, userId: req.user.mongoId });
            unregisterRealtimeSession(session._id);
            await deleteSession({ GridSimulatorSession, GridSimulatorTrade, sessionId: req.params.sessionId, userId: req.user.mongoId });
            return res.json({ success: true });
        } catch (error) {
            return handleError(res, error, "Failed to delete grid simulator session");
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
            const charges = await getChargesSummary({ GridSimulatorTrade, sessionId: req.params.sessionId, segmentClass: session.config.segmentClass });
            return res.json(sessionDetail(session, getPortfolioMetrics, tradeCounts, charges));
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
