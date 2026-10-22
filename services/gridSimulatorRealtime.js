/**
 * Grid Trading Simulator — PAPER TRADING ONLY. Event-driven, real-time
 * price processing. Replaces the old dedicated 5-second poll loop
 * (services/gridSimulatorFeed.js, removed) with a direct subscription to
 * marketDataService's tick events, so an ACTIVE session's grid is
 * evaluated the moment a genuine Upstox WebSocket tick arrives for its
 * instrument — not on a fixed timer, and not dependent on any browser tab
 * being open.
 *
 * ADR-023: ONLY a genuine WebSocket tick (tickEmitter "tick") may trigger
 * an authoritative fill. A REST-fallback price (tickEmitter "fallbackTick",
 * only ever emitted while the socket is down) is honestly surfaced as
 * LIVE_REST_FALLBACK display/feed-health status and NOTHING ELSE — it
 * never calls processTick(), never advances the crossing watermark, never
 * creates a trade. See processSessionTick()'s doc comment below.
 *
 * Architecture (ADR-022/ADR-023, .claude/state/DECISIONS.md):
 *   Upstox WS → marketDataService.handleTick() → tickEmitter "tick"
 *     → gridSimulatorRealtime (this file) → gridSimulatorService.processTick()
 *     → persisted session state + trade ledger → Socket.IO room
 *       "grid-session:<sessionId>" → frontend
 *   Upstox WS down → marketDataService REST fallback → tickEmitter
 *     "fallbackTick" → gridSimulatorRealtime → display-only feed-status
 *     update (LIVE_REST_FALLBACK) → Socket.IO room → frontend (no trade)
 *
 * Subscription safety: registers/unregisters each ACTIVE session's
 * instrument via marketDataService.pinInstrument()/unpinInstrument() —
 * the additive, reference-counted layer (ADR-022) that coexists with
 * subscribe()'s own watchlist-driven full-set-replace without either
 * disrupting the other.
 *
 * In-memory registry rebuild: sessionsByInstrument/instrumentBySession
 * live only in process memory. resyncFromDb() rebuilds them from every
 * currently-ACTIVE GridSimulatorSession — called once at server startup
 * (restart recovery for the registry itself; the session's own
 * cash/holdings/trade-ledger state is already durably persisted and
 * recovered via gridSimulatorService, independent of this registry).
 */

const marketDataService = require("./marketDataService");
const { processTick, nearestPendingLevels } = require("./gridSimulatorService");
const { computePortfolioMetrics } = require("./gridSimulatorEngine");

// 15s was found too tight live: a healthy, continuously-connected feed
// (zero logged WS disconnects) still produced 3-4 false-positive STALE
// flips over a 30-40 minute session, because the engine only records a
// ledger event on an actual grid-level crossing — a genuine brief lull
// between crossings (well under the 15s threshold in observed gap data,
// but the RAW tick stream itself can briefly quiet down between price
// changes) was enough to trip it. 25s keeps a real multi-tens-of-seconds
// outage caught quickly (detected within one extra watchdog tick) while
// tolerating a normal brief lull.
const STALE_THRESHOLD_MS = Number(process.env.GRID_SIMULATOR_STALE_MS || 25_000);
const WATCHDOG_INTERVAL_MS = Number(process.env.GRID_SIMULATOR_WATCHDOG_MS || 5_000);

const instrumentBySession = new Map(); // sessionId (string) -> instrumentKey
const sessionsByInstrument = new Map(); // instrumentKey -> Set<sessionId (string)>
const lastTickAtByInstrument = new Map(); // instrumentKey -> ms epoch of the last tick (any source)
const staleSessionIds = new Set(); // sessionId (string) currently marked STALE — lets the recovery path log a transition without an extra DB read per tick

let deps = null; // { GridSimulatorSession, GridSimulatorTrade, io }
let watchdogTimer = null;
let tickListenersAttached = false;

function registerSession(session) {
    const sessionId = String(session._id);
    const instrumentKey = session.instrumentKey;
    if (instrumentBySession.has(sessionId)) return; // already registered — idempotent

    instrumentBySession.set(sessionId, instrumentKey);
    if (!sessionsByInstrument.has(instrumentKey)) {
        sessionsByInstrument.set(instrumentKey, new Set());
    }
    sessionsByInstrument.get(instrumentKey).add(sessionId);

    marketDataService.pinInstrument(instrumentKey);
}

function unregisterSession(sessionId) {
    const key = String(sessionId);
    const instrumentKey = instrumentBySession.get(key);
    if (!instrumentKey) return; // not registered — idempotent

    staleSessionIds.delete(key);
    instrumentBySession.delete(key);
    const set = sessionsByInstrument.get(instrumentKey);
    if (set) {
        set.delete(key);
        if (!set.size) sessionsByInstrument.delete(instrumentKey);
    }

    marketDataService.unpinInstrument(instrumentKey);
}

/**
 * Builds the Socket.IO "gridSimulatorUpdate" payload from a SINGLE,
 * internally-consistent snapshot (`sessionDoc`, the just-persisted
 * document). Always recomputes `portfolio` via the same authoritative
 * computePortfolioMetrics() the REST detail route uses (ADR-029) — it
 * previously hand-built `portfolio` with only cash/holdings/avgCost/
 * realizedPnL, omitting equity/unrealizedPnL/marketValue entirely. The
 * frontend's merge (`{...prev.portfolio, ...payload.portfolio}`) then
 * silently KEPT the stale equity/unrealizedPnL from an earlier push while
 * cash/holdings/avgCost/realizedPnL updated to the latest values — an
 * internally inconsistent snapshot (fresh holdings/cost mixed with a
 * stale valuation), which is exactly the equity/unrealizedPnL discrepancy
 * reported against production. Recomputing every field here, every push,
 * from the one persisted doc guarantees cash/holdings/avgCost/equity/
 * unrealizedPnL/marketValue are always mutually consistent.
 */
function buildUpdatePayload(sessionDoc, result, source) {
    const currentPrice = sessionDoc.lastFeedPrice ?? sessionDoc.state?.lastPrice ?? null;
    const metrics = computePortfolioMetrics(sessionDoc.state || {}, currentPrice);
    return {
        sessionId: String(sessionDoc._id),
        status: sessionDoc.status,
        lastFeedStatus: sessionDoc.lastFeedStatus,
        lastFeedCheckAt: sessionDoc.lastFeedCheckAt,
        lastFeedPrice: sessionDoc.lastFeedPrice,
        source,
        state: {
            lastPrice: result.state?.lastPrice ?? sessionDoc.state?.lastPrice ?? null,
            ...nearestPendingLevels({
                state: {
                    pendingBuyLevels: result.state?.pendingBuyLevels ?? sessionDoc.state?.pendingBuyLevels,
                    pendingSellLevels: result.state?.pendingSellLevels ?? sessionDoc.state?.pendingSellLevels,
                    activeReference: result.state?.activeReference ?? sessionDoc.state?.activeReference,
                    holdings: result.state?.holdings ?? sessionDoc.state?.holdings,
                },
                config: sessionDoc.config || {},
            }),
            lastEventTimestamp: result.state?.lastEventTimestamp ?? sessionDoc.state?.lastEventTimestamp ?? null,
            sequence: result.state?.sequence ?? sessionDoc.state?.sequence ?? 0,
        },
        portfolio: metrics,
        trades: (result.trades || []).filter((t) => t.qtyFilled > 0 || t.qtySkipped > 0),
    };
}

/**
 * Only a genuine WebSocket tick (source "ws") may trigger an authoritative
 * fill — a REST-fallback price (source "rest", only ever emitted while the
 * WS socket is down) NEVER calls processTick(): it updates only the
 * session's display/feed-health fields (lastFeedStatus=LIVE_REST_FALLBACK,
 * lastFeedPrice) and pushes those to the frontend, with zero effect on the
 * crossing watermark, cash, holdings, or the trade ledger. This is a hard
 * rule, not a tunable default — see ADR-023.
 */
async function processSessionTick(sessionId, { price, timestamp, source }) {
    const { GridSimulatorSession, GridSimulatorTrade, io } = deps;

    if (source !== "ws") {
        const updated = await GridSimulatorSession.findOneAndUpdate(
            { _id: sessionId, status: "ACTIVE" },
            { $set: { lastFeedCheckAt: new Date(), lastFeedStatus: "LIVE_REST_FALLBACK", lastFeedPrice: price } },
            { new: true },
        );
        if (!updated) return; // paused/stopped/deleted — nothing to display-update
        if (io) {
            io.to(`grid-session:${sessionId}`).emit("gridSimulatorUpdate", buildUpdatePayload(updated, { trades: [], state: updated.state }, source));
        }
        return;
    }

    const eventTimestamp = new Date(timestamp).toISOString();
    const result = await processTick({ GridSimulatorSession, GridSimulatorTrade, sessionId, price, eventTimestamp });

    // Not ACTIVE (paused/stopped since registration) or lost a lock race —
    // neither is an error; unregisterSession() will catch up with it on the
    // next pause/stop transition, this is just a stale in-flight tick.
    if (result.skipped && result.reason === "locked-or-inactive") return;

    const updated = await GridSimulatorSession.findOneAndUpdate(
        { _id: sessionId },
        { $set: { lastFeedCheckAt: new Date(), lastFeedStatus: "LIVE", lastFeedPrice: price } },
        { new: true },
    );
    if (!updated) return; // session was deleted/not found — nothing left to push

    // Transition log paired with the watchdog's STALE log above — together
    // they give an exact, permanent record of every staleness episode's
    // start and end, so a future occurrence can be diagnosed precisely
    // (duration, whether it correlates with a logged WS disconnect)
    // instead of needing a one-off temporary diagnostic.
    if (staleSessionIds.delete(String(sessionId))) {
        console.warn(`Grid session ${sessionId} recovered from STALE — a genuine tick arrived.`);
    }

    if (io) {
        io.to(`grid-session:${sessionId}`).emit("gridSimulatorUpdate", buildUpdatePayload(updated, result, source));
    }
}

function handleUpstreamTick(tick, source) {
    const sessionIds = sessionsByInstrument.get(tick.instrumentKey);
    lastTickAtByInstrument.set(tick.instrumentKey, Date.now());
    if (!sessionIds || !sessionIds.size) return;

    sessionIds.forEach((sessionId) => {
        // Fire-and-forget, per-session isolated — one session's DB error
        // must never block or drop another session's processing of the
        // same tick.
        processSessionTick(sessionId, { price: tick.ltp, timestamp: tick.timestamp, source }).catch((error) => {
            console.error(`Grid simulator realtime processing error (session ${sessionId}):`, error.message);
        });
    });
}

/**
 * Staleness watchdog — NOT a price-polling loop. It makes zero Upstox/REST
 * calls; it only inspects timestamps already updated by genuine tick
 * events and flips a session's lastFeedStatus to STALE if none has
 * arrived recently. This is what satisfies "if no genuine upstream tick
 * is received, the simulator must not pretend to be live."
 */
function runStalenessWatchdog() {
    const { GridSimulatorSession } = deps;
    const nowMs = Date.now();

    sessionsByInstrument.forEach((sessionIds, instrumentKey) => {
        const lastTickAt = lastTickAtByInstrument.get(instrumentKey);
        const isStale = !lastTickAt || nowMs - lastTickAt > STALE_THRESHOLD_MS;
        if (!isStale) return;

        sessionIds.forEach((sessionId) => {
            GridSimulatorSession.findOneAndUpdate(
                { _id: sessionId, lastFeedStatus: { $ne: "STALE" } },
                { $set: { lastFeedCheckAt: new Date(nowMs), lastFeedStatus: "STALE" } },
                { new: true },
            )
                .then((updated) => {
                    if (updated) {
                        // Permanent transition log — lets a future staleness
                        // episode be diagnosed precisely (exact gap duration,
                        // whether it correlates with a logged WS disconnect)
                        // instead of needing a one-off temporary diagnostic.
                        const gapMs = lastTickAt ? nowMs - lastTickAt : null;
                        console.warn(`Grid session ${sessionId} (${instrumentKey}) marked STALE — no genuine tick for ${gapMs != null ? `${(gapMs / 1000).toFixed(1)}s` : "an unknown duration (no tick ever recorded)"}.`);
                        staleSessionIds.add(String(sessionId));
                    }
                    if (updated && deps.io) {
                        deps.io.to(`grid-session:${sessionId}`).emit("gridSimulatorUpdate", {
                            sessionId: String(sessionId),
                            status: updated.status,
                            lastFeedStatus: "STALE",
                            lastFeedCheckAt: updated.lastFeedCheckAt,
                            lastFeedPrice: updated.lastFeedPrice,
                            source: null,
                            state: { lastPrice: updated.state?.lastPrice, lastEventTimestamp: updated.state?.lastEventTimestamp, sequence: updated.state?.sequence },
                            portfolio: { cash: updated.state?.cash, holdings: updated.state?.holdings, avgCost: updated.state?.avgCost, realizedPnL: updated.state?.realizedPnL },
                            trades: [],
                        });
                    }
                })
                .catch((error) => console.error(`Grid simulator staleness watchdog error (session ${sessionId}):`, error.message));
        });
    });
}

/** Rebuilds the in-memory registry from every currently-ACTIVE session —
 *  called once at server startup. The session's own state/trade ledger is
 *  already durable in Mongo; this only restores which instruments this
 *  process needs to pin/listen for. */
async function resyncFromDb({ GridSimulatorSession }) {
    const activeSessions = await GridSimulatorSession.find({ status: "ACTIVE" });
    activeSessions.forEach(registerSession);
    return activeSessions.length;
}

function init({ GridSimulatorSession, GridSimulatorTrade, io }) {
    deps = { GridSimulatorSession, GridSimulatorTrade, io };

    if (!tickListenersAttached) {
        marketDataService.tickEmitter.on("tick", (tick) => handleUpstreamTick(tick, "ws"));
        marketDataService.tickEmitter.on("fallbackTick", (tick) => handleUpstreamTick(tick, "rest"));
        tickListenersAttached = true;
    }

    if (!watchdogTimer) {
        watchdogTimer = setInterval(() => runStalenessWatchdog(), WATCHDOG_INTERVAL_MS);
        watchdogTimer.unref?.();
    }
}

function shutdown() {
    if (watchdogTimer) {
        clearInterval(watchdogTimer);
        watchdogTimer = null;
    }
}

module.exports = {
    init,
    shutdown,
    registerSession,
    unregisterSession,
    resyncFromDb,
    STALE_THRESHOLD_MS,
    WATCHDOG_INTERVAL_MS,
    // exported for white-box tests only
    handleUpstreamTick,
    processSessionTick,
    sessionsByInstrument,
    instrumentBySession,
    lastTickAtByInstrument,
    runStalenessWatchdog,
    staleSessionIds,
};
