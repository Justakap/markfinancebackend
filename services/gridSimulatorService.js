/**
 * Grid Trading Simulator — PAPER TRADING ONLY. Session lifecycle + tick
 * processing orchestration, kept separate from routes/gridSimulatorRoutes.js
 * (same convention as services/liveStrategyService.js vs. its route file).
 *
 * CONCURRENCY / RESTART SAFETY (mirrors services/liveStrategyOrchestrator.js,
 * ADR-015): `processTick()` first atomically claims a short-TTL lock via a
 * conditional findOneAndUpdate (status: ACTIVE AND lock unset/expired).
 * Only the caller that wins proceeds. The pure engine result is computed in
 * memory, then committed in ONE atomic update (state + watermark + lock
 * release), and only THEN are GridSimulatorTrade ledger rows inserted. If
 * the process crashes between the two writes, the simulated cash/holdings
 * state is already safely committed and will never be reprocessed or
 * duplicated — the only possible loss is a gap in the trade-ledger log for
 * that one event, never a duplicated fill or a corrupted position.
 */

const {
    validateGridConfig,
    createShellState,
    startWithInitialBuy,
    processPriceUpdate,
    computePortfolioMetrics,
    roundPrice,
    annotateRunningState,
} = require("./gridSimulatorEngine");
const { summarizeCharges } = require("./gridChargesCalculator");

const LOCK_DURATION_MS = Number(process.env.GRID_SIMULATOR_LOCK_MS || 30_000);
const NON_TERMINAL_STATUSES = ["CREATED", "ACTIVE", "PAUSED"];

function makeError(statusCode, message) {
    const error = new Error(message);
    error.statusCode = statusCode;
    error.clientMessage = message;
    return error;
}

/**
 * ADR-038: the reference price is captured at START time, not creation —
 * a session is created with NO reference yet (`config.referencePrice`/
 * `referenceCapturedAt` both null) and a reference-free "shell" state
 * (`createShellState()`). `validateGridConfig` is still run against a
 * placeholder referencePrice (same precedent as gridBacktestService.js,
 * which validates before its own real reference — the first candle's
 * close — is known) so every OTHER field (variance, qty, capital, etc.)
 * is still fully validated now, at creation.
 */
async function createSession({ GridSimulatorSession, userId, instrumentKey, symbol, config }) {
    const validation = validateGridConfig({ ...config, referencePrice: config.referencePrice || 1 });
    if (!validation.valid) {
        throw makeError(400, `Invalid grid configuration: ${validation.errors.join("; ")}`);
    }

    const existing = await GridSimulatorSession.findOne({
        userId,
        instrumentKey,
        status: { $in: NON_TERMINAL_STATUSES },
    });
    if (existing) {
        throw makeError(409, "A grid simulator session for this instrument is already running or paused. Stop it before creating a new one.");
    }

    const initialState = createShellState(config);

    try {
        const session = await GridSimulatorSession.create({
            userId,
            instrumentKey,
            symbol,
            status: "CREATED",
            config: {
                referencePrice: null,
                referenceCapturedAt: null,
                gridInterval: config.gridInterval,
                sellVariance: config.sellVariance ?? null,
                quantityPerLevel: config.quantityPerLevel,
                sellQuantityPerLevel: config.sellQuantityPerLevel ?? null,
                startingCapital: config.startingCapital,
                maxPositionSize: config.maxPositionSize ?? null,
                startingHoldings: config.startingHoldings ?? 0,
                startingAvgCost: config.startingHoldings > 0 ? config.startingAvgCost : 0,
                segmentClass: config.segmentClass || "EQUITY_DELIVERY",
            },
            state: initialState,
        });
        return session;
    } catch (error) {
        if (error.code === 11000) {
            throw makeError(409, "A grid simulator session for this instrument is already running or paused. Stop it before creating a new one.");
        }
        throw error;
    }
}

async function getOwnedSession({ GridSimulatorSession, sessionId, userId }) {
    const session = await GridSimulatorSession.findOne({ _id: sessionId, userId });
    if (!session) {
        throw makeError(404, "Grid simulator session not found");
    }
    return session;
}

async function transitionStatus({ GridSimulatorSession, sessionId, userId, from, to, extraSet = {} }) {
    const session = await getOwnedSession({ GridSimulatorSession, sessionId, userId });
    if (!from.includes(session.status)) {
        throw makeError(409, `Cannot transition from ${session.status} to ${to}`);
    }
    const updated = await GridSimulatorSession.findOneAndUpdate(
        { _id: session._id, status: { $in: from } },
        { $set: { status: to, ...extraSet } },
        { new: true },
    );
    if (!updated) {
        // Lost a race with another concurrent transition request.
        throw makeError(409, `Cannot transition from its current state to ${to}`);
    }
    return updated;
}

function pauseSession(deps) {
    return transitionStatus({ ...deps, from: ["ACTIVE"], to: "PAUSED" });
}

function resumeSession(deps) {
    return transitionStatus({ ...deps, from: ["PAUSED"], to: "ACTIVE" });
}

function stopSession(deps) {
    return transitionStatus({ ...deps, from: ["CREATED", "ACTIVE", "PAUSED"], to: "STOPPED", extraSet: { stoppedAt: new Date() } });
}

/**
 * ADR-038: the ONLY way a CREATED session becomes ACTIVE — captures the
 * reference price right now (the caller, gridSimulatorRoutes.js, must
 * already have fetched+validated a fresh live quote, same provenance
 * requirement ADR-023/024 used to apply at creation) and immediately
 * executes one real BUY fill at that exact price
 * (`startWithInitialBuy()`), recording it as the session's first ledger
 * row even if it's skipped/partial (never silently dropped — same
 * discipline `processTick` already applies to every other fill attempt).
 * Resuming a PAUSED session (`resumeSession`) is a completely separate,
 * unchanged path — it never re-captures a reference or re-buys.
 */
async function startSessionWithInitialBuy({ GridSimulatorSession, GridSimulatorTrade, sessionId, userId, referencePrice, referenceCapturedAt }) {
    const session = await getOwnedSession({ GridSimulatorSession, sessionId, userId });
    if (session.status !== "CREATED") {
        throw makeError(409, `Cannot start from its current state (${session.status})`);
    }

    const config = {
        referencePrice,
        gridInterval: session.config.gridInterval,
        sellVariance: session.config.sellVariance ?? null,
        quantityPerLevel: session.config.quantityPerLevel,
        sellQuantityPerLevel: session.config.sellQuantityPerLevel ?? null,
        startingCapital: session.config.startingCapital,
        maxPositionSize: session.config.maxPositionSize,
        startingHoldings: session.config.startingHoldings,
        startingAvgCost: session.config.startingAvgCost,
    };

    const { state, trade } = startWithInitialBuy(config, referenceCapturedAt);

    const updated = await GridSimulatorSession.findOneAndUpdate(
        { _id: session._id, status: "CREATED" },
        {
            $set: {
                status: "ACTIVE",
                startedAt: new Date(),
                "config.referencePrice": referencePrice,
                "config.referenceCapturedAt": referenceCapturedAt,
                ...stateToDocFields(state),
                "state.tradeSequence": 1,
            },
        },
        { new: true },
    );
    if (!updated) {
        throw makeError(409, "Session status changed before it could be started — refresh and try again");
    }

    const startState = {
        cash: config.startingCapital,
        holdings: config.startingHoldings,
        lots: config.startingHoldings > 0 ? [{ qty: config.startingHoldings, price: config.startingAvgCost }] : [],
    };
    const [annotated] = annotateRunningState([trade], startState).map((t) => ({ ...t, sequence: 1, gapFill: false, eventTimestamp: referenceCapturedAt }));
    await GridSimulatorTrade.insertMany([tradeToDoc({ trade: annotated, session: updated, sequence: 1, eventTimestamp: referenceCapturedAt, gapFill: false })]);

    return updated;
}

function docStateToPlain(doc) {
    const s = doc.state || {};
    return {
        cash: s.cash,
        holdings: s.holdings,
        // ADR-032: FIFO lot queue. A session persisted before this field
        // existed has no `lots` at all — fall back to an empty queue (its
        // next SELL will have nothing to consume from, matching the
        // already-correct "no holdings to sell" skip path; such a legacy
        // session's holdings should already be 0 in practice since the old
        // weighted-average model never left a position without a cost
        // basis). `.toObject()` handles a real Mongoose DocumentArray.
        lots: Array.isArray(s.lots) ? s.lots.map((lot) => ({ qty: lot.qty, price: lot.price })) : typeof s.lots?.toObject === "function" ? s.lots.toObject() : [],
        avgCost: s.avgCost,
        realizedPnL: s.realizedPnL,
        lastPrice: s.lastPrice ?? null,
        // ADR-037: a session with a non-empty pendingBuyLevels has already
        // migrated (every real session, new or old-but-migrated, always
        // keeps at least one armed buy level — see the engine's doc
        // comment). A session that's never been migrated has an empty
        // array (the schema default) but a non-null `activeReference` —
        // lazily synthesize its starting pending levels from that old
        // anchor the same way scripts/backfillGridPendingLevels.js does,
        // so an un-migrated session keeps working even before that script
        // runs. `.toObject()`-free: these are plain Number arrays already.
        ...(() => {
            const hasMigrated = Array.isArray(s.pendingBuyLevels) && s.pendingBuyLevels.length > 0;
            if (hasMigrated) {
                return { pendingBuyLevels: s.pendingBuyLevels, pendingSellLevels: s.pendingSellLevels || [] };
            }
            const legacyReference = s.activeReference ?? doc.config.referencePrice;
            const buyVariance = doc.config.gridInterval;
            const sellVariance = doc.config.sellVariance ?? doc.config.gridInterval;
            return {
                pendingBuyLevels: [roundPrice(legacyReference - buyVariance)],
                pendingSellLevels: s.holdings > 0 ? [roundPrice(legacyReference + sellVariance)] : [],
            };
        })(),
        lastEventTimestamp: s.lastEventTimestamp ?? null,
        sequence: s.sequence || 0,
        tradeSequence: s.tradeSequence || 0,
    };
}

function stateToDocFields(state) {
    return {
        "state.cash": state.cash,
        "state.holdings": state.holdings,
        "state.lots": state.lots,
        "state.avgCost": state.avgCost,
        "state.realizedPnL": state.realizedPnL,
        "state.lastPrice": state.lastPrice,
        "state.pendingBuyLevels": state.pendingBuyLevels,
        "state.pendingSellLevels": state.pendingSellLevels,
        "state.lastEventTimestamp": state.lastEventTimestamp,
        "state.sequence": state.sequence,
    };
}

function tradeToDoc({ trade, session, sequence, eventTimestamp, gapFill }) {
    return {
        sessionId: session._id,
        userId: session.userId,
        sequence,
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
        gapFill,
        eventTimestamp,
        // Explicit, not relied on as a schema default — this label is
        // safety-critical (paper trading only) and must survive even
        // against a persistence layer that doesn't apply Mongoose defaults
        // (e.g. a test double, or a future export/migration path).
        isSimulated: true,
    };
}

/**
 * Processes exactly one price update for one session. Dependency-injected
 * models, same factory convention as every other service in this codebase
 * — tests never need live MongoDB.
 */
async function processTick({ GridSimulatorSession, GridSimulatorTrade, sessionId, price, eventTimestamp, now }) {
    const nowMs = now ? now() : Date.now();
    const lockUntil = new Date(nowMs + LOCK_DURATION_MS);

    const claimed = await GridSimulatorSession.findOneAndUpdate(
        {
            _id: sessionId,
            status: "ACTIVE",
            $or: [{ processingLockedUntil: null }, { processingLockedUntil: { $lte: new Date(nowMs) } }],
        },
        { $set: { processingLockedUntil: lockUntil } },
        { new: true },
    );

    if (!claimed) {
        return { skipped: true, reason: "locked-or-inactive" };
    }

    try {
        const state = docStateToPlain(claimed);
        const result = processPriceUpdate({ config: claimed.config, state, price, eventTimestamp });
        const nextTradeSequence = state.tradeSequence + result.trades.length;

        await GridSimulatorSession.findOneAndUpdate(
            { _id: claimed._id },
            {
                $set: {
                    ...stateToDocFields(result.state),
                    "state.tradeSequence": nextTradeSequence,
                    processingLockedUntil: null,
                },
            },
        );

        let ledgerTrades = result.trades;
        if (result.trades.length) {
            const annotated = annotateRunningState(result.trades, state).map((trade, i) => ({
                ...trade,
                sequence: state.tradeSequence + 1 + i,
                gapFill: result.gapFill,
                eventTimestamp,
            }));
            await GridSimulatorTrade.insertMany(annotated.map((trade) => tradeToDoc({ trade, session: claimed, sequence: trade.sequence, eventTimestamp, gapFill: result.gapFill })));
            // Returned to the caller (e.g. gridSimulatorRealtime.js's Socket.IO
            // push) fully annotated, exactly as persisted — avoids a second
            // DB round trip just to re-fetch what was already computed here.
            ledgerTrades = annotated;
        }

        return { skipped: result.skipped === true, reason: result.reason, trades: ledgerTrades, state: result.state };
    } catch (error) {
        await GridSimulatorSession.findOneAndUpdate({ _id: claimed._id }, { $set: { processingLockedUntil: null } }).catch(() => {});
        throw error;
    }
}

async function listSessions({ GridSimulatorSession, userId, page = 1, limit = 20, status }) {
    const filter = { userId };
    if (status) filter.status = status;
    const skip = (page - 1) * limit;
    const [items, total] = await Promise.all([
        GridSimulatorSession.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
        GridSimulatorSession.countDocuments(filter),
    ]);
    return { items, total, page, limit };
}

async function listTrades({ GridSimulatorTrade, sessionId, page = 1, limit = 50, skippedOnly = false }) {
    const filter = { sessionId };
    if (skippedOnly) filter.qtySkipped = { $gt: 0 };
    const skip = (page - 1) * limit;
    const [items, total] = await Promise.all([
        GridSimulatorTrade.find(filter).sort({ sequence: -1 }).skip(skip).limit(limit),
        GridSimulatorTrade.countDocuments(filter),
    ]);
    return { items, total, page, limit };
}

/**
 * Buy/sell/skip/partial counts across the ENTIRE session's ledger —
 * computed via countDocuments, never by loading every trade into memory
 * (a long-running session's ledger can run into the hundreds/thousands).
 * Mirrors gridBacktestService.js's computeTradeCounts() shape/semantics
 * exactly, reused here for the live simulator's own trade ledger.
 */
async function getTradeCounts({ GridSimulatorTrade, sessionId }) {
    const [buyCount, sellCount, skippedCount, partialCount] = await Promise.all([
        GridSimulatorTrade.countDocuments({ sessionId, type: "BUY", qtyFilled: { $gt: 0 } }),
        GridSimulatorTrade.countDocuments({ sessionId, type: "SELL", qtyFilled: { $gt: 0 } }),
        GridSimulatorTrade.countDocuments({ sessionId, qtyFilled: 0 }),
        GridSimulatorTrade.countDocuments({ sessionId, qtyFilled: { $gt: 0 }, qtySkipped: { $gt: 0 } }),
    ]);
    return { buyCount, sellCount, skippedCount, partialCount };
}

/**
 * DISPLAY-ONLY statutory/brokerage charges estimate across a session's
 * WHOLE ledger (ADR-035) — never affects cash/holdings/realizedPnL. Only
 * the fields the calculator actually needs are selected, since a long-
 * running session's ledger can run into the hundreds/thousands.
 */
async function getChargesSummary({ GridSimulatorTrade, sessionId, segmentClass }) {
    const trades = await GridSimulatorTrade.find({ sessionId, qtyFilled: { $gt: 0 } });
    return summarizeCharges(trades, segmentClass);
}

/**
 * Edits a session's live-tunable config (quantityPerLevel, gridInterval/
 * sellVariance, and a cash top-up) — ADR-034. Deliberately restricted to
 * PAUSED only: this avoids a tick being processed concurrently with a
 * half-applied edit (e.g. a crossing firing against the old variance a
 * moment before the new one takes effect). `patch.addCash` (if provided)
 * is always a positive top-up applied via $inc, never an overwrite of
 * cash — overwriting would silently disconnect the cash balance from the
 * realized P&L/trade history that's supposed to explain it.
 */
async function updateSessionConfig({ GridSimulatorSession, sessionId, userId, patch }) {
    const session = await getOwnedSession({ GridSimulatorSession, sessionId, userId });
    if (session.status !== "PAUSED") {
        throw makeError(409, "Pause the session before editing its configuration");
    }

    const current = session.config;
    const nextConfig = {
        referencePrice: current.referencePrice,
        gridInterval: patch.gridInterval != null ? patch.gridInterval : current.gridInterval,
        sellVariance: Object.prototype.hasOwnProperty.call(patch, "sellVariance") ? patch.sellVariance : (current.sellVariance ?? null),
        quantityPerLevel: patch.quantityPerLevel != null ? patch.quantityPerLevel : current.quantityPerLevel,
        sellQuantityPerLevel: Object.prototype.hasOwnProperty.call(patch, "sellQuantityPerLevel") ? patch.sellQuantityPerLevel : (current.sellQuantityPerLevel ?? null),
        startingCapital: current.startingCapital,
        maxPositionSize: current.maxPositionSize,
        startingHoldings: current.startingHoldings,
        startingAvgCost: current.startingAvgCost,
    };

    const validation = validateGridConfig(nextConfig);
    if (!validation.valid) {
        throw makeError(400, `Invalid grid configuration: ${validation.errors.join("; ")}`);
    }

    const updateOp = {
        $set: {
            "config.gridInterval": nextConfig.gridInterval,
            "config.sellVariance": nextConfig.sellVariance,
            "config.quantityPerLevel": nextConfig.quantityPerLevel,
            "config.sellQuantityPerLevel": nextConfig.sellQuantityPerLevel,
        },
    };
    if (patch.addCash != null && patch.addCash > 0) {
        updateOp.$inc = { "state.cash": patch.addCash };
    }

    const updated = await GridSimulatorSession.findOneAndUpdate({ _id: session._id, status: "PAUSED" }, updateOp, { new: true });
    if (!updated) {
        throw makeError(409, "Session status changed before the update could be applied — refresh and try again");
    }
    return updated;
}

/**
 * Permanently deletes a session and its trade ledger. Allowed regardless
 * of status — the caller (routes/gridSimulatorRoutes.js) is responsible
 * for unregistering the session from the real-time registry first so an
 * ACTIVE/PAUSED session's instrument pin is released and no further tick
 * ever tries to process the now-deleted document.
 */
async function deleteSession({ GridSimulatorSession, GridSimulatorTrade, sessionId, userId }) {
    const session = await getOwnedSession({ GridSimulatorSession, sessionId, userId });
    await GridSimulatorTrade.deleteMany({ sessionId: session._id });
    await GridSimulatorSession.deleteOne({ _id: session._id });
    return session;
}

function getPortfolioMetrics(session, currentPrice) {
    return computePortfolioMetrics(docStateToPlain(session), currentPrice);
}

/**
 * ADR-037: the single "Active Reference" display concept is replaced by
 * the two NEAREST currently-armed trigger prices (the full
 * pendingBuyLevels/pendingSellLevels sets are internal engine state, not
 * exposed in full — see gridSimulatorEngine.js's file doc comment for why
 * they can grow over a long session). Falls back to deriving from the
 * legacy `activeReference` for a session not yet migrated (same formula
 * as docStateToPlain() above and scripts/backfillGridPendingLevels.js).
 * Pure/stateless — takes a plain `{ state, config }`-shaped object, same
 * precedent as gridChargesCalculator.js's classifySegmentClass (imported
 * directly where needed, not DI-injected).
 */
function nearestPendingLevels({ state, config }) {
    const hasMigrated = Array.isArray(state.pendingBuyLevels) && state.pendingBuyLevels.length > 0;
    if (hasMigrated) {
        const sells = state.pendingSellLevels || [];
        return {
            nextBuyLevel: Math.max(...state.pendingBuyLevels),
            nextSellLevel: sells.length ? Math.min(...sells) : null,
        };
    }
    // ADR-038: a CREATED session not yet started has no reference at all
    // (neither the legacy activeReference nor config.referencePrice) —
    // genuinely nothing to report yet, never fabricate a number from null.
    const legacyReference = state.activeReference ?? config.referencePrice;
    if (legacyReference == null) {
        return { nextBuyLevel: null, nextSellLevel: null };
    }
    const sellVariance = config.sellVariance ?? config.gridInterval;
    return {
        nextBuyLevel: legacyReference - config.gridInterval,
        nextSellLevel: state.holdings > 0 ? legacyReference + sellVariance : null,
    };
}

module.exports = {
    createSession,
    getOwnedSession,
    startSessionWithInitialBuy,
    pauseSession,
    resumeSession,
    stopSession,
    processTick,
    listSessions,
    listTrades,
    getTradeCounts,
    getChargesSummary,
    updateSessionConfig,
    deleteSession,
    getPortfolioMetrics,
    nearestPendingLevels,
    docStateToPlain,
    LOCK_DURATION_MS,
};
