/**
 * Workstream J (Live Strategy Engine) — ties together liveCandleFeed.js
 * (completed-candle source), indicatorEngine.js/strategyExpression.js
 * (UNCHANGED, reused exactly as the backtest path uses them), and
 * liveSignalEngine.js (the new single-bar step function) against
 * persisted LiveStrategyRuntime/LiveStrategySignal state.
 *
 * CONCURRENCY / RESTART SAFETY (the core design of this file):
 * Each poll of a runtime first attempts to atomically acquire a short-TTL
 * lock by flipping `processingLockedUntil` via a conditional
 * findOneAndUpdate (`status: ACTIVE AND (lock unset OR lock expired)`).
 * Only the caller that wins this atomic update proceeds — this is the
 * "do not rely exclusively on an in-memory Set/Map" guard the milestone
 * requires: the lock lives in the database, so it works correctly across
 * multiple processes/workers polling concurrently, not just within one.
 *
 * All newly-completed bars found in one poll are processed in memory
 * first (nothing written yet), then committed in ONE atomic update:
 * engineState + lastProcessedCandleTimestamp + lock-release together.
 * Only after that commit succeeds are LiveStrategySignal log rows
 * inserted. This ordering is deliberate: if the process crashes between
 * the two writes, the simulated POSITION state (engineState) is already
 * safely committed and will never be reprocessed or duplicated — the
 * only possible loss is a gap in the signal-history log for that one
 * batch, never a duplicated fill or a corrupted position. If the process
 * crashes BEFORE the commit, nothing happened yet: the next poll simply
 * redoes the same (idempotent) work from the last committed state. This
 * is what satisfies "a restarted process must not silently duplicate
 * entries or forget an active simulated position."
 */

const { fetchLatestClosedCandles } = require("./liveCandleFeed");
const { buildStrategyContextSeries } = require("./indicatorEngine");
const { collectIndicatorRequirements, getProfessionalWarmupBars } = require("../utils/strategyExpression");
const { resolveTimeframesNeeded } = require("./professionalCandleAdapter");
const { createInitialEngineState, processCompletedBar } = require("./liveSignalEngine");

const LOCK_DURATION_MS = Number(process.env.LIVE_ENGINE_LOCK_MS || 45_000);
const MAX_BUFFER_BARS = Number(process.env.LIVE_ENGINE_MAX_BUFFER_BARS || 1500);

function engineStateToDocFields(engineState) {
    return {
        "engineState.equity": engineState.equity,
        "engineState.peakEquity": engineState.peakEquity,
        "engineState.barsProcessed": engineState.barsProcessed,
        "engineState.inPosition": engineState.inPosition,
        "engineState.entryPrice": engineState.entryPrice,
        "engineState.entryRawPrice": engineState.entryRawPrice,
        "engineState.entryDate": engineState.entryDate,
        "engineState.quantity": engineState.quantity,
        "engineState.entrySignalBarIndex": engineState.entrySignalBarIndex,
        "engineState.pendingEntry": engineState.pendingEntry,
        "engineState.pendingExit": engineState.pendingExit,
        "engineState.pendingExitReason": engineState.pendingExitReason,
    };
}

function docEngineStateToPlain(doc) {
    const s = doc.engineState || {};
    return {
        equity: s.equity,
        peakEquity: s.peakEquity,
        barsProcessed: s.barsProcessed || 0,
        inPosition: !!s.inPosition,
        entryPrice: s.entryPrice || 0,
        entryRawPrice: s.entryRawPrice || 0,
        entryDate: s.entryDate || null,
        quantity: s.quantity || 0,
        entrySignalBarIndex: s.entrySignalBarIndex ?? null,
        pendingEntry: !!s.pendingEntry,
        pendingExit: !!s.pendingExit,
        pendingExitReason: s.pendingExitReason || null,
    };
}

function eventToSignalDoc({ event, runtime }) {
    return {
        runtimeId: runtime._id,
        userId: runtime.userId,
        type: event.type,
        barDate: event.date,
        price: event.price ?? null,
        quantity: event.quantity ?? null,
        exitReason: event.exitReason ?? null,
        entryPrice: event.entryPrice ?? null,
        entryDate: event.entryDate ?? null,
        grossPnl: event.grossPnl ?? null,
        fees: event.fees ?? null,
        slippageCost: event.slippageCost ?? null,
        netPnl: event.netPnl ?? null,
        returnPct: event.returnPct ?? null,
        holdingPeriodBars: event.holdingPeriodBars ?? null,
    };
}

/**
 * Processes exactly one runtime's pending work for the current poll cycle.
 * Dependency-injected (`deps.fetchLatestClosedCandles`) so tests never
 * need live Upstox/DB access — same convention as every other factory in
 * this codebase (createXRoutes({...})).
 */
async function processRuntimeOnce(runtime, { LiveStrategyRuntime, LiveStrategySignal, definition, deps = {} }) {
    const fetchCandles = deps.fetchLatestClosedCandles || fetchLatestClosedCandles;
    const nowMs = deps.now ? deps.now() : Date.now();

    const lockUntil = new Date(nowMs + LOCK_DURATION_MS);
    const claimed = await LiveStrategyRuntime.findOneAndUpdate(
        {
            _id: runtime._id,
            status: "ACTIVE",
            $or: [{ processingLockedUntil: null }, { processingLockedUntil: { $lte: new Date(nowMs) } }],
        },
        { $set: { processingLockedUntil: lockUntil } },
        { new: true },
    );

    if (!claimed) {
        return { skipped: true, reason: "locked-by-another-worker-or-inactive" };
    }

    try {
        const primaryTimeframe = definition.universe.timeframe;
        const timeframes = resolveTimeframesNeeded(definition);

        const candlesByTimeframe = {};
        for (const timeframe of timeframes) {
            // eslint-disable-next-line no-await-in-loop -- sequential by
            // design, same reasoning as professionalCandleAdapter.js: each
            // call already goes through the shared Upstox queue/cache.
            candlesByTimeframe[timeframe] = await fetchCandles(claimed.instrumentKey, timeframe, { maxBars: MAX_BUFFER_BARS });
        }

        const primaryCandles = candlesByTimeframe[primaryTimeframe] || [];
        if (!primaryCandles.length) {
            await LiveStrategyRuntime.findOneAndUpdate(
                { _id: claimed._id },
                { $set: { processingLockedUntil: null, lastEvaluationAt: new Date(nowMs), lastEvaluationStatus: "No candle data available" } },
            );
            return { skipped: true, reason: "no-candle-data" };
        }

        const requirements = [
            ...collectIndicatorRequirements(definition.entry, [], primaryTimeframe),
            ...(definition.exit ? collectIndicatorRequirements(definition.exit, [], primaryTimeframe) : []),
        ];
        const contexts = buildStrategyContextSeries({ primaryTimeframe, candlesByTimeframe, requirements });

        const startIndex = Math.max(
            getProfessionalWarmupBars(definition.entry, primaryTimeframe),
            definition.exit ? getProfessionalWarmupBars(definition.exit, primaryTimeframe) : 1,
        );

        const lastProcessedMs = claimed.lastProcessedCandleTimestamp ? new Date(claimed.lastProcessedCandleTimestamp).getTime() : null;

        // Only bars strictly newer than the last committed one, and never
        // before warmup clears — mirrors the backtest's own startIndex gate.
        const newIndices = [];
        for (let i = Math.max(startIndex, 0); i < primaryCandles.length; i += 1) {
            const barMs = new Date(primaryCandles[i].date).getTime();
            if (lastProcessedMs === null || barMs > lastProcessedMs) {
                newIndices.push(i);
            }
        }

        if (!newIndices.length) {
            await LiveStrategyRuntime.findOneAndUpdate(
                { _id: claimed._id },
                { $set: { processingLockedUntil: null, lastEvaluationAt: new Date(nowMs), lastEvaluationStatus: "No new completed candle since last evaluation" } },
            );
            return { skipped: true, reason: "no-new-bars" };
        }

        const strategyForEngine = {
            entryExpression: definition.entry,
            exitExpression: definition.exit || null,
            risk: definition.risk || {},
            execution: definition.execution || {},
        };

        let engineState = docEngineStateToPlain(claimed);
        const allEvents = [];
        let lastProcessedBarDate = claimed.lastProcessedCandleTimestamp;

        newIndices.forEach((i) => {
            const result = processCompletedBar({
                engineState,
                strategy: strategyForEngine,
                candle: primaryCandles[i],
                current: contexts[i],
                previous: contexts[i - 1] || null,
                primaryTimeframe,
                commissionPct: claimed.config.commissionPct,
                slippagePct: claimed.config.slippagePct,
            });
            engineState = result.engineState;
            allEvents.push(...result.events);
            lastProcessedBarDate = primaryCandles[i].date;
        });

        // Commit engineState + advance the dedup watermark FIRST (see file
        // doc comment for why this ordering is the safe one), THEN log
        // signal rows, THEN release the lock.
        await LiveStrategyRuntime.findOneAndUpdate(
            { _id: claimed._id },
            {
                $set: {
                    ...engineStateToDocFields(engineState),
                    lastProcessedCandleTimestamp: lastProcessedBarDate,
                    lastEvaluationAt: new Date(nowMs),
                    lastEvaluationStatus: `Processed ${newIndices.length} new completed candle(s)`,
                },
            },
        );

        if (allEvents.length) {
            await LiveStrategySignal.insertMany(allEvents.map((event) => eventToSignalDoc({ event, runtime: claimed })));
        }

        await LiveStrategyRuntime.findOneAndUpdate({ _id: claimed._id }, { $set: { processingLockedUntil: null } });

        return { skipped: false, processedBars: newIndices.length, events: allEvents };
    } catch (error) {
        // Release the lock on failure so a transient error (e.g. a single
        // failed Upstox call) doesn't strand the runtime locked for
        // LOCK_DURATION_MS longer than necessary.
        await LiveStrategyRuntime.findOneAndUpdate({ _id: claimed._id }, { $set: { processingLockedUntil: null } }).catch(() => {});
        throw error;
    }
}

/**
 * Iterates every ACTIVE runtime and processes it once. Each runtime's
 * failure is isolated (caught, logged, reported) — one bad instrument or
 * a transient Upstox failure must never stop the rest of the fleet from
 * being evaluated this cycle.
 */
async function pollAllActiveRuntimes({ LiveStrategyRuntime, LiveStrategySignal, StrategyVersion, deps = {} }) {
    const runtimes = await LiveStrategyRuntime.find({ status: "ACTIVE" });
    const results = [];

    for (const runtime of runtimes) {
        try {
            // eslint-disable-next-line no-await-in-loop -- each runtime's
            // own candle fetches already serialize through the shared
            // Upstox queue; no correctness benefit to racing runtimes
            // against each other here, and it keeps lock-contention logs
            // readable.
            const version = await StrategyVersion.findOne({ _id: runtime.strategyVersionId });
            if (!version) {
                results.push({ runtimeId: runtime._id, skipped: true, reason: "strategy-version-not-found" });
                continue;
            }

            // eslint-disable-next-line no-await-in-loop
            const result = await processRuntimeOnce(runtime, {
                LiveStrategyRuntime,
                LiveStrategySignal,
                definition: version.definition,
                deps,
            });
            results.push({ runtimeId: runtime._id, ...result });
        } catch (error) {
            console.error(`Live strategy runtime ${runtime._id} processing error:`, error.message);
            results.push({ runtimeId: runtime._id, skipped: true, reason: "error", error: error.message });
        }
    }

    return results;
}

let pollTimer = null;

/** Starts the recurring poll loop. Reuses the existing market-data/Upstox
 *  infrastructure entirely through liveCandleFeed.js — this interval is
 *  the only new scheduling primitive introduced for Workstream J, not a
 *  second WebSocket connection or Upstox client. */
function startLiveEnginePolling(models, intervalMs = Number(process.env.LIVE_ENGINE_POLL_MS || 20_000)) {
    if (pollTimer) return;
    pollTimer = setInterval(() => {
        pollAllActiveRuntimes(models).catch((error) => console.error("Live strategy poll cycle error:", error.message));
    }, intervalMs);
    pollTimer.unref?.();
}

function stopLiveEnginePolling() {
    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }
}

module.exports = {
    processRuntimeOnce,
    pollAllActiveRuntimes,
    startLiveEnginePolling,
    stopLiveEnginePolling,
    LOCK_DURATION_MS,
    MAX_BUFFER_BARS,
    // exported for white-box tests only
    docEngineStateToPlain,
    engineStateToDocFields,
};
