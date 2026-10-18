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
    createInitialGridState,
    processPriceUpdate,
    computePortfolioMetrics,
    roundPrice,
} = require("./gridSimulatorEngine");

const LOCK_DURATION_MS = Number(process.env.GRID_SIMULATOR_LOCK_MS || 30_000);
const NON_TERMINAL_STATUSES = ["CREATED", "ACTIVE", "PAUSED"];

function makeError(statusCode, message) {
    const error = new Error(message);
    error.statusCode = statusCode;
    error.clientMessage = message;
    return error;
}

async function createSession({ GridSimulatorSession, userId, instrumentKey, symbol, config }) {
    const validation = validateGridConfig(config);
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

    const initialState = createInitialGridState(config);

    try {
        const session = await GridSimulatorSession.create({
            userId,
            instrumentKey,
            symbol,
            status: "CREATED",
            config: {
                referencePrice: config.referencePrice,
                gridInterval: config.gridInterval,
                quantityPerLevel: config.quantityPerLevel,
                startingCapital: config.startingCapital,
                maxPositionSize: config.maxPositionSize ?? null,
                commissionPct: config.commissionPct ?? 0,
                slippagePct: config.slippagePct ?? 0,
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

function startSession(deps) {
    return transitionStatus({ ...deps, from: ["CREATED", "PAUSED"], to: "ACTIVE", extraSet: { startedAt: new Date() } });
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

function docStateToPlain(doc) {
    const s = doc.state || {};
    return {
        cash: s.cash,
        holdings: s.holdings,
        avgCost: s.avgCost,
        realizedPnL: s.realizedPnL,
        lastPrice: s.lastPrice ?? null,
        lastEventTimestamp: s.lastEventTimestamp ?? null,
        levelArmed: s.levelArmed && typeof s.levelArmed.toObject === "function" ? s.levelArmed.toObject() : { ...(s.levelArmed || {}) },
        sequence: s.sequence || 0,
        tradeSequence: s.tradeSequence || 0,
    };
}

function stateToDocFields(state) {
    return {
        "state.cash": state.cash,
        "state.holdings": state.holdings,
        "state.avgCost": state.avgCost,
        "state.realizedPnL": state.realizedPnL,
        "state.lastPrice": state.lastPrice,
        "state.lastEventTimestamp": state.lastEventTimestamp,
        "state.levelArmed": state.levelArmed,
        "state.sequence": state.sequence,
    };
}

/**
 * Replays the engine's already-decided trades (in their original order)
 * over the pre-update state to recover each trade's own running
 * cash/holdings/avgCost snapshot for the ledger — using only each trade's
 * own recorded fields (qtyFilled/effectivePrice/type) plus the session's
 * commissionPct, the exact same arithmetic gridSimulatorEngine.js's
 * applyBuy/applySell already used internally. This never re-decides
 * anything (quantities/prices are already final) — it only reconstructs
 * the audit trail the pure engine's return value doesn't carry per-trade.
 */
function annotateRunningState(trades, startState, commissionPct) {
    let cash = startState.cash;
    let holdings = startState.holdings;
    let avgCost = startState.avgCost;

    return trades.map((trade) => {
        if (trade.type === "BUY" && trade.qtyFilled > 0) {
            const unitCost = roundPrice(trade.effectivePrice * (1 + commissionPct / 100));
            const cost = roundPrice(trade.qtyFilled * unitCost);
            const newHoldings = holdings + trade.qtyFilled;
            avgCost = roundPrice((avgCost * holdings + cost) / newHoldings);
            holdings = newHoldings;
            cash = roundPrice(cash - cost);
        } else if (trade.type === "SELL" && trade.qtyFilled > 0) {
            const unitProceeds = roundPrice(trade.effectivePrice * (1 - commissionPct / 100));
            const proceeds = roundPrice(trade.qtyFilled * unitProceeds);
            holdings -= trade.qtyFilled;
            cash = roundPrice(cash + proceeds);
            if (holdings === 0) avgCost = 0;
        }
        return { ...trade, cashAfter: cash, holdingsAfter: holdings, avgCostAfter: avgCost };
    });
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
        effectivePrice: trade.effectivePrice,
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
            const annotated = annotateRunningState(result.trades, state, claimed.config.commissionPct ?? 0).map((trade, i) => ({
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

function getPortfolioMetrics(session, currentPrice) {
    return computePortfolioMetrics(docStateToPlain(session), currentPrice);
}

module.exports = {
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
    docStateToPlain,
    LOCK_DURATION_MS,
};
