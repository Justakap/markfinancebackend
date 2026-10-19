/**
 * Grid Backtest — PAPER TRADING / HISTORICAL SIMULATION ONLY. Orchestrates
 * historical candle retrieval (reusing candleService.js's existing
 * chunked/cached/quality-aware infrastructure — ADR-025/027), the shared
 * dynamic-reference grid engine (services/gridSimulatorEngine.js via
 * services/gridBacktestEngine.js), and persistence. Never touches
 * marketDataService, never pins a live instrument, never mutates a live
 * GridSimulatorSession — fully isolated from the live simulator's
 * authoritative execution path (ADR-027).
 */

const { validateGridConfig, computePortfolioMetrics, roundPrice } = require("./gridSimulatorEngine");
const { replayCandles, findInitialReferenceCandle } = require("./gridBacktestEngine");

const VALID_TIMEFRAMES = ["1m", "5m", "15m", "1h", "1d"];
const INTERVAL_TO_UPSTOX = {
    "1m": { unit: "minutes", interval: "1" },
    "5m": { unit: "minutes", interval: "5" },
    "15m": { unit: "minutes", interval: "15" },
    "1h": { unit: "hours", interval: "1" },
    "1d": { unit: "days", interval: "1" },
};
// One step finer than each key — null means "already the finest supported."
const FINER_TIMEFRAME = { "1d": "1h", "1h": "15m", "15m": "5m", "5m": "1m", "1m": null };

// Bounds to avoid an unbounded replay job / uncontrolled historical-data
// concurrency (the task's own explicit constraint) — generous enough for a
// genuinely long backtest, never unlimited.
const MAX_SPAN_DAYS = { "1m": 60, "5m": 180, "15m": 365, "1h": 730, "1d": 3650 };
const MAX_BARS = 20000;

function makeError(statusCode, message) {
    const error = new Error(message);
    error.statusCode = statusCode;
    error.clientMessage = message;
    return error;
}

function isValidDateString(s) {
    return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(`${s}T00:00:00Z`).getTime());
}

function validateBacktestRequest({ timeframe, requestedStartDate, requestedEndDate, config }) {
    const errors = [];

    if (!VALID_TIMEFRAMES.includes(timeframe)) {
        errors.push(`timeframe must be one of ${VALID_TIMEFRAMES.join(", ")}`);
    }
    if (!isValidDateString(requestedStartDate) || !isValidDateString(requestedEndDate)) {
        errors.push("requestedStartDate/requestedEndDate must be valid YYYY-MM-DD dates");
    } else if (requestedStartDate >= requestedEndDate) {
        errors.push("requestedStartDate must be strictly before requestedEndDate");
    } else if (VALID_TIMEFRAMES.includes(timeframe)) {
        const spanDays = Math.round((new Date(`${requestedEndDate}T00:00:00Z`) - new Date(`${requestedStartDate}T00:00:00Z`)) / 86400000);
        const maxSpan = MAX_SPAN_DAYS[timeframe];
        if (spanDays > maxSpan) {
            errors.push(`the requested range (${spanDays} days) exceeds the maximum supported span for ${timeframe} (${maxSpan} days)`);
        }
    }

    // referencePrice/referenceCapturedAt aren't known yet at this pre-fetch
    // stage (they come from the first valid historical candle, fetched
    // afterward) — placeholders satisfy validateGridConfig's own presence
    // checks for those two fields without affecting validation of every
    // other field this function actually cares about here.
    const gridValidation = validateGridConfig({ ...config, referencePrice: config.referencePrice || 1, referenceCapturedAt: config.referenceCapturedAt || new Date().toISOString() });
    if (!gridValidation.valid) errors.push(...gridValidation.errors.filter((e) => !e.startsWith("referencePrice")));

    return { valid: errors.length === 0, errors };
}

/**
 * Tries a finer timeframe (if one exists) for the exact same date range,
 * via the SAME chunked/cached/quality-aware fetcher as the primary
 * request. Only used when it returns real, non-empty, non-incomplete
 * data — otherwise the caller falls back to the conservative intrabar
 * policy on the originally-requested timeframe. Never fabricates data,
 * never silently prefers whichever path "performs better."
 */
async function fetchWithFinerFallback({ fetchRange, instrumentKey, timeframe, requestedStartDate, requestedEndDate, maxBars }) {
    const primaryUpstox = INTERVAL_TO_UPSTOX[timeframe];
    const primary = await fetchRange(instrumentKey, primaryUpstox.unit, primaryUpstox.interval, requestedStartDate, requestedEndDate, maxBars);

    const finerTf = FINER_TIMEFRAME[timeframe];
    if (!finerTf) {
        return { ...primary, usedTimeframe: timeframe, usedFinerGrainedCandles: false };
    }

    const finerUpstox = INTERVAL_TO_UPSTOX[finerTf];
    let finer = null;
    try {
        finer = await fetchRange(instrumentKey, finerUpstox.unit, finerUpstox.interval, requestedStartDate, requestedEndDate, MAX_BARS);
    } catch {
        finer = null;
    }

    if (finer && finer.candles?.length && !finer.incomplete) {
        return { ...finer, usedTimeframe: finerTf, usedFinerGrainedCandles: true };
    }

    return { ...primary, usedTimeframe: timeframe, usedFinerGrainedCandles: false };
}

function buildTradeDocs({ trades, backtestId, userId }) {
    return trades.map((trade, i) => ({
        backtestId,
        userId,
        sequence: i + 1,
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
        assumedIntrabar: trade.assumedIntrabar,
        candleTimestamp: trade.candleTimestamp,
        eventTimestamp: trade.eventTimestamp,
        isSimulated: true,
    }));
}

/** Walks the trade ledger in order to recover each trade's actual cash
 *  impact versus its raw (fillPrice * qty) notional — the difference IS
 *  the modeled transaction cost (commission + slippage combined), using
 *  only each trade's own recorded fields, same "replay, never re-decide"
 *  discipline as gridSimulatorService.js's annotateRunningState. */
function computeTotalCosts(trades, startingCash) {
    let prevCash = startingCash;
    let total = 0;
    trades.forEach((trade) => {
        if (trade.qtyFilled <= 0) return;
        const rawNotional = roundPrice(trade.qtyFilled * trade.fillPrice);
        const cashDelta = roundPrice(trade.cashAfter - prevCash);
        const cost = trade.type === "BUY" ? roundPrice(-cashDelta - rawNotional) : roundPrice(rawNotional - cashDelta);
        total = roundPrice(total + cost);
        prevCash = trade.cashAfter;
    });
    return total;
}

function computeTradeCounts(trades) {
    let buyCount = 0;
    let sellCount = 0;
    let partialCount = 0;
    let skippedCount = 0;
    trades.forEach((trade) => {
        if (trade.qtyFilled > 0) {
            if (trade.type === "BUY") buyCount += 1;
            else sellCount += 1;
            if (trade.qtySkipped > 0) partialCount += 1;
        } else {
            skippedCount += 1;
        }
    });
    return { buyCount, sellCount, partialCount, skippedCount };
}

/**
 * Runs a full grid backtest synchronously (same convention as the
 * existing legacy/professional backtest routes — bounded by MAX_SPAN_DAYS/
 * MAX_BARS rather than a new async job system). Persists a COMPLETED or
 * FAILED GridBacktestResult either way — a failed run never looks like a
 * silently-successful empty one.
 */
async function runGridBacktest({ GridBacktestResult, GridBacktestTrade, userId, instrumentKey, symbol, timeframe, requestedStartDate, requestedEndDate, config, fetchRange }) {
    const validation = validateBacktestRequest({ timeframe, requestedStartDate, requestedEndDate, config });
    if (!validation.valid) {
        throw makeError(400, `Invalid grid backtest request: ${validation.errors.join("; ")}`);
    }

    const backtest = await GridBacktestResult.create({
        userId,
        instrumentKey,
        symbol,
        status: "RUNNING",
        config: {
            timeframe,
            requestedStartDate,
            requestedEndDate,
            gridInterval: config.gridInterval,
            quantityPerLevel: config.quantityPerLevel,
            startingCapital: config.startingCapital,
            maxPositionSize: config.maxPositionSize ?? null,
            commissionPct: config.commissionPct ?? 0,
            slippagePct: config.slippagePct ?? 0,
            startingHoldings: config.startingHoldings ?? 0,
            startingAvgCost: config.startingHoldings > 0 ? config.startingAvgCost : 0,
        },
    });

    try {
        const fetchResult = await fetchWithFinerFallback({
            fetchRange,
            instrumentKey,
            timeframe,
            requestedStartDate,
            requestedEndDate,
            maxBars: MAX_BARS,
        });

        const candles = (fetchResult.candles || []).filter((c) => Number.isFinite(c?.close) && c.close > 0);
        if (!candles.length) {
            throw makeError(400, "No historical candle data is available for the requested instrument/range. The backtest cannot be started.");
        }

        const refCandle = findInitialReferenceCandle(candles);
        if (!refCandle) {
            throw makeError(400, "No valid historical candle (positive, finite close) exists in the requested range.");
        }
        const refIndex = candles.indexOf(refCandle);
        const replaySeries = candles.slice(refIndex);

        const replayConfig = {
            ...config,
            referencePrice: roundPrice(refCandle.close),
            referenceCapturedAt: refCandle.timestamp,
        };

        const replay = replayCandles({ config: replayConfig, candles: replaySeries, isFinerGrained: fetchResult.usedFinerGrainedCandles });

        const lastCandle = replaySeries[replaySeries.length - 1];
        const finalPortfolio = computePortfolioMetrics(replay.state, lastCandle.close);
        const initialEquity = roundPrice(config.startingCapital + (config.startingHoldings || 0) * refCandle.close);
        const netPnL = finalPortfolio.equity != null ? roundPrice(finalPortfolio.equity - initialEquity) : null;
        const returnPct = finalPortfolio.equity != null && initialEquity > 0 ? roundPrice((netPnL / initialEquity) * 100) : null;
        const counts = computeTradeCounts(replay.trades);
        const totalCosts = computeTotalCosts(replay.trades, config.startingCapital);

        const tradeDocs = buildTradeDocs({ trades: replay.trades, backtestId: backtest._id, userId });
        if (tradeDocs.length) {
            await GridBacktestTrade.insertMany(tradeDocs);
        }

        const updated = await GridBacktestResult.findOneAndUpdate(
            { _id: backtest._id },
            {
                $set: {
                    status: "COMPLETED",
                    initialReference: { price: refCandle.close, timestamp: refCandle.timestamp },
                    dataQuality: {
                        usedTimeframe: fetchResult.usedTimeframe,
                        actualStartDate: new Date(refCandle.timestamp).toISOString().slice(0, 10),
                        actualEndDate: new Date(lastCandle.timestamp).toISOString().slice(0, 10),
                        candleCount: replaySeries.length,
                        incomplete: !!fetchResult.incomplete,
                        failedRanges: fetchResult.failedRanges || [],
                        retentionClamped: !!fetchResult.retentionClamped,
                        retentionFrom: fetchResult.retentionFrom || null,
                        usedFinerGrainedCandles: fetchResult.usedFinerGrainedCandles,
                        intrabarAssumption: fetchResult.usedFinerGrainedCandles ? "observed-finer-grained" : "conservative-open-low-high-close",
                        costModelNote: "Commission/slippage are the only modeled costs — STT, exchange transaction charges, GST, SEBI turnover fees, and stamp duty are NOT included.",
                    },
                    finalState: {
                        cash: replay.state.cash,
                        holdings: replay.state.holdings,
                        avgCost: replay.state.avgCost,
                        realizedPnL: replay.state.realizedPnL,
                    },
                    metrics: {
                        endingEquity: finalPortfolio.equity,
                        netPnL,
                        returnPct,
                        realizedPnL: replay.state.realizedPnL,
                        unrealizedPnL: finalPortfolio.unrealizedPnL,
                        ...counts,
                        totalCosts,
                        maxDrawdownPct: replay.maxDrawdownPct,
                        maxCapitalDeployed: replay.maxCapitalDeployed,
                    },
                    equitySeries: replay.equitySeries,
                    completedAt: new Date(),
                },
            },
            { new: true },
        );

        return updated;
    } catch (error) {
        await GridBacktestResult.findOneAndUpdate(
            { _id: backtest._id },
            { $set: { status: "FAILED", error: error.clientMessage || error.message, completedAt: new Date() } },
        ).catch(() => {});
        throw error;
    }
}

async function getOwnedBacktest({ GridBacktestResult, backtestId, userId }) {
    const backtest = await GridBacktestResult.findOne({ _id: backtestId, userId });
    if (!backtest) throw makeError(404, "Grid backtest not found");
    return backtest;
}

async function listBacktests({ GridBacktestResult, userId, page = 1, limit = 20 }) {
    const skip = (page - 1) * limit;
    const [items, total] = await Promise.all([
        GridBacktestResult.find({ userId }).sort({ createdAt: -1 }).skip(skip).limit(limit),
        GridBacktestResult.countDocuments({ userId }),
    ]);
    return { items, total, page, limit };
}

async function listBacktestTrades({ GridBacktestTrade, backtestId, page = 1, limit = 100 }) {
    const skip = (page - 1) * limit;
    const [items, total] = await Promise.all([
        GridBacktestTrade.find({ backtestId }).sort({ sequence: 1 }).skip(skip).limit(limit),
        GridBacktestTrade.countDocuments({ backtestId }),
    ]);
    return { items, total, page, limit };
}

module.exports = {
    VALID_TIMEFRAMES,
    INTERVAL_TO_UPSTOX,
    FINER_TIMEFRAME,
    MAX_SPAN_DAYS,
    MAX_BARS,
    validateBacktestRequest,
    runGridBacktest,
    getOwnedBacktest,
    listBacktests,
    listBacktestTrades,
    // exported for white-box tests only
    computeTotalCosts,
    computeTradeCounts,
    fetchWithFinerFallback,
};
