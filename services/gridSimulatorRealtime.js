/**
 * Grid Trading Simulator — PAPER TRADING ONLY. Event-driven, real-time
 * price processing. Replaces the old dedicated 5-second poll loop
 * (services/gridSimulatorFeed.js, removed) with a direct subscription to
 * marketDataService's tick events, so an ACTIVE session's grid is
 * evaluated the moment a genuine Upstox WebSocket tick (or, honestly
 * labeled, a REST-fallback price while the socket is down) arrives for
 * its instrument — not on a fixed timer, and not dependent on any
 * browser tab being open.
 *
 * Architecture (ADR-022, .claude/state/DECISIONS.md):
 *   Upstox WS → marketDataService.handleTick() → tickEmitter "tick"
 *     → gridSimulatorRealtime (this file) → gridSimulatorService.processTick()
 *     → persisted session state + trade ledger → Socket.IO room
 *       "grid-session:<sessionId>" → frontend
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
const { processTick } = require("./gridSimulatorService");

const STALE_THRESHOLD_MS = Number(process.env.GRID_SIMULATOR_STALE_MS || 15_000);
const WATCHDOG_INTERVAL_MS = Number(process.env.GRID_SIMULATOR_WATCHDOG_MS || 5_000);

const instrumentBySession = new Map(); // sessionId (string) -> instrumentKey
const sessionsByInstrument = new Map(); // instrumentKey -> Set<sessionId (string)>
const lastTickAtByInstrument = new Map(); // instrumentKey -> ms epoch of the last tick (any source)

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

    instrumentBySession.delete(key);
    const set = sessionsByInstrument.get(instrumentKey);
    if (set) {
        set.delete(key);
        if (!set.size) sessionsByInstrument.delete(instrumentKey);
    }

    marketDataService.unpinInstrument(instrumentKey);
}

function buildUpdatePayload(sessionDoc, result, source) {
    return {
        sessionId: String(sessionDoc._id),
        status: sessionDoc.status,
        lastFeedStatus: sessionDoc.lastFeedStatus,
        lastFeedCheckAt: sessionDoc.lastFeedCheckAt,
        lastFeedPrice: sessionDoc.lastFeedPrice,
        source,
        state: {
            lastPrice: result.state?.lastPrice ?? sessionDoc.state?.lastPrice ?? null,
            lastEventTimestamp: result.state?.lastEventTimestamp ?? sessionDoc.state?.lastEventTimestamp ?? null,
            sequence: result.state?.sequence ?? sessionDoc.state?.sequence ?? 0,
        },
        portfolio: {
            cash: sessionDoc.state?.cash,
            holdings: sessionDoc.state?.holdings,
            avgCost: sessionDoc.state?.avgCost,
            realizedPnL: sessionDoc.state?.realizedPnL,
        },
        trades: (result.trades || []).filter((t) => t.qtyFilled > 0 || t.qtySkipped > 0),
    };
}

async function processSessionTick(sessionId, { price, timestamp, source }) {
    const { GridSimulatorSession, GridSimulatorTrade, io } = deps;
    const eventTimestamp = new Date(timestamp).toISOString();

    const result = await processTick({ GridSimulatorSession, GridSimulatorTrade, sessionId, price, eventTimestamp });

    // Not ACTIVE (paused/stopped since registration) or lost a lock race —
    // neither is an error; unregisterSession() will catch up with it on the
    // next pause/stop transition, this is just a stale in-flight tick.
    if (result.skipped && result.reason === "locked-or-inactive") return;

    const feedStatus = source === "ws" ? "LIVE" : "LIVE_REST_FALLBACK";
    const updated = await GridSimulatorSession.findOneAndUpdate(
        { _id: sessionId },
        { $set: { lastFeedCheckAt: new Date(), lastFeedStatus: feedStatus, lastFeedPrice: price } },
        { new: true },
    );
    if (!updated) return; // session was deleted/not found — nothing left to push

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
};
