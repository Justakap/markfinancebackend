/**
 * Grid Trading Simulator — PAPER TRADING ONLY. Price sourcing + polling
 * loop for ACTIVE GridSimulatorSession documents.
 *
 * ADR-021 (see .claude/state/DECISIONS.md): deliberately does NOT call
 * marketDataService.subscribe() — that function performs a destructive
 * set-REPLACE of `subscribedInstruments` (and prunes `liveData` for
 * anything not in its argument), so a second independent caller using it
 * for a grid instrument would silently unsubscribe whatever watchlist a
 * user currently has open, and vice versa. Instead, every poll cycle calls
 * the already-existing `warmLiveQuotes(instrumentKeys)` directly (REST LTP,
 * same Upstox request queue/retry/backoff, "critical" priority — identical
 * to what `GET /api/market-data/:id` already does) for exactly the
 * instruments this session's ACTIVE sessions need, then reads the shared
 * `liveData` map. This never touches `subscribedInstruments` and merges
 * additively with any existing WS-sourced entry for the same key — the
 * existing watchlist live-tick feature is completely unaffected.
 *
 * Freshness/staleness is judged from `liveData`'s own `timestamp` field —
 * a price older than STALE_THRESHOLD_MS is never treated as live and is
 * never fed into the grid engine (see gridSimulatorEngine.js's own
 * "do not fabricate a price" validation as a second line of defense).
 *
 * A session can ALSO be advanced lower-latency by the frontend pushing a
 * tick it already received over its own Socket.IO `marketTick`
 * subscription (routes/gridSimulatorRoutes.js's POST .../tick) — both
 * paths funnel into the exact same idempotent gridSimulatorService.processTick,
 * so whichever arrives first wins and the other is a safe no-op duplicate.
 */

const { processTick } = require("./gridSimulatorService");

const POLL_INTERVAL_MS = Number(process.env.GRID_SIMULATOR_POLL_MS || 5_000);
const STALE_THRESHOLD_MS = Number(process.env.GRID_SIMULATOR_STALE_MS || 3 * POLL_INTERVAL_MS);

async function pollAllActiveSessions({ GridSimulatorSession, GridSimulatorTrade, marketDataService, processTick }) {
    const sessions = await GridSimulatorSession.find({ status: "ACTIVE" });
    if (!sessions.length) return [];

    const instrumentKeys = [...new Set(sessions.map((s) => s.instrumentKey))];
    await marketDataService.warmLiveQuotes(instrumentKeys);

    const nowMs = Date.now();
    const results = [];

    for (const session of sessions) {
        try {
            const live = marketDataService.liveData.get(session.instrumentKey);
            const isFresh = live && Number.isFinite(live.ltp) && live.ltp > 0 && nowMs - (live.timestamp || 0) <= STALE_THRESHOLD_MS;

            if (!isFresh) {
                const status = !live ? "NO_DATA" : "STALE";
                // eslint-disable-next-line no-await-in-loop -- isolate each
                // session's own small write; no correctness benefit to
                // racing these against each other.
                await GridSimulatorSession.findOneAndUpdate(
                    { _id: session._id },
                    { $set: { lastFeedCheckAt: new Date(nowMs), lastFeedStatus: status } },
                );
                results.push({ sessionId: session._id, skipped: true, reason: status.toLowerCase() });
                continue;
            }

            // eslint-disable-next-line no-await-in-loop
            await GridSimulatorSession.findOneAndUpdate(
                { _id: session._id },
                { $set: { lastFeedCheckAt: new Date(nowMs), lastFeedStatus: "LIVE", lastFeedPrice: live.ltp } },
            );

            // eslint-disable-next-line no-await-in-loop
            const result = await processTick({
                GridSimulatorSession,
                GridSimulatorTrade,
                sessionId: session._id,
                price: live.ltp,
                eventTimestamp: new Date(live.timestamp).toISOString(),
            });
            results.push({ sessionId: session._id, ...result });
        } catch (error) {
            console.error(`Grid simulator session ${session._id} processing error:`, error.message);
            results.push({ sessionId: session._id, skipped: true, reason: "error", error: error.message });
        }
    }

    return results;
}

let pollTimer = null;

function startGridSimulatorPolling(models, intervalMs = POLL_INTERVAL_MS) {
    if (pollTimer) return;
    pollTimer = setInterval(() => {
        pollAllActiveSessions({ ...models, processTick }).catch((error) =>
            console.error("Grid simulator poll cycle error:", error.message),
        );
    }, intervalMs);
    pollTimer.unref?.();
}

function stopGridSimulatorPolling() {
    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }
}

module.exports = {
    pollAllActiveSessions,
    startGridSimulatorPolling,
    stopGridSimulatorPolling,
    POLL_INTERVAL_MS,
    STALE_THRESHOLD_MS,
};
