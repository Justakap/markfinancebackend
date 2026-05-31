const {
    calculateWilderRsi,
    calculateEma,
    getLatestRsi,
    round2,
} = require("./indicators");
const { fetchChart } = require("./yahooClient");
const {
    evaluateStrategy,
    evaluateCondition,
    getBacktestStartIndex,
} = require("./strategyEvaluator");
const { normalizeIndicatorLabel } = require("./indicatorCatalog");

const PERIOD_DAYS = {
    "1mo": 30,
    "3mo": 90,
    "6mo": 180,
    "1y": 365,
    "2y": 730,
    "5y": 1825,
};

const INTERVAL_CONFIG = {
    "1m": { yahoo: "1m", maxDays: 6, label: "1 Minute" },
    "5m": { yahoo: "5m", maxDays: 28, label: "5 Minute" },
    "15m": { yahoo: "15m", maxDays: 55, label: "15 Minute" },
    "1h": { yahoo: "1h", maxDays: 700, label: "1 Hour" },
    "1d": { yahoo: "1d", maxDays: 1825, label: "Daily" },
};

const INTERVAL_RANK = { "1m": 1, "5m": 2, "15m": 3, "1h": 4, "1d": 5 };

const RSI_LABEL_TO_INTERVAL = {
    "RSI (1 Minute)": "1m",
    "RSI (5 Minute)": "5m",
    "RSI (15 Minute)": "15m",
    "RSI (1 Hour)": "1h",
    "RSI (Daily)": "1d",
};

const INTERVAL_TO_RSI = {
    "1m": { field: "rsi1m", prev: "prevRsi1m" },
    "5m": { field: "rsi5m", prev: "prevRsi5m" },
    "15m": { field: "rsi15m", prev: "prevRsi15m" },
    "1h": { field: "hourlyRsi", prev: "prevHourlyRsi" },
    "1d": { field: "rsi", prev: "prevRsi" },
};

function collectStrategyIndicators(strategy) {
    const entry = strategy.entryConditions?.length
        ? strategy.entryConditions
        : strategy.conditions || [];
    const exit = strategy.exitConditions || [];

    return [...entry, ...exit].flatMap((condition) => {
        const values = [condition.indicator];
        if (condition.compareType === "indicator") values.push(condition.value);
        return values;
    });
}

function getRequiredRsiIntervals(strategy) {
    const intervals = new Set();

    collectStrategyIndicators(strategy).forEach((label) => {
        const normalized = normalizeIndicatorLabel(label);
        if (!normalized) return;

        const interval = RSI_LABEL_TO_INTERVAL[normalized];
        if (interval) intervals.add(interval);
    });

    return [...intervals];
}

function getStrategyInterval(strategy) {
    const intervals = getRequiredRsiIntervals(strategy);
    let finest = "1d";

    intervals.forEach((interval) => {
        if (INTERVAL_RANK[interval] < INTERVAL_RANK[finest]) {
            finest = interval;
        }
    });

    return finest;
}

function resolveBacktestConfig(strategy, period) {
    const interval = getStrategyInterval(strategy);
    const requiredIntervals = getRequiredRsiIntervals(strategy);
    const config = INTERVAL_CONFIG[interval];
    const requestedDays = PERIOD_DAYS[period] || 365;
    const effectiveDays = Math.min(requestedDays, config.maxDays);
    const capped = requestedDays > config.maxDays;

    let message = null;

    if (capped) {
        message = `${config.label} backtests are limited to ~${config.maxDays} days of history (Yahoo Finance). Using ${effectiveDays} days instead of ${requestedDays} for this run.`;
    }

    if (requiredIntervals.length > 1) {
        const tfNote = `Multi-timeframe strategy: aligning ${requiredIntervals
            .map((key) => INTERVAL_CONFIG[key].label)
            .join(" + ")} RSI onto ${config.label} candles.`;
        message = message ? `${message} ${tfNote}` : tfNote;
    }

    return {
        interval,
        yahooInterval: config.yahoo,
        requestedDays,
        effectiveDays,
        capped,
        message,
        label: config.label,
        requiredIntervals,
    };
}

function computeRsiOnCandles(candles) {
    const closes = candles.map((c) => c.close);
    const rsiValues = calculateWilderRsi(closes, 14);

    return candles.map((candle, index) => ({
        time: new Date(candle.date).getTime(),
        rsi: rsiValues[index] ?? null,
    }));
}

function computeDirectRsiWithPrev(candles) {
    const series = computeRsiOnCandles(candles);

    return series.map((point, index) => ({
        rsi: point.rsi,
        prevRsi: index > 0 ? series[index - 1].rsi : null,
    }));
}

function alignRsiToPrimaryBars(primaryCandles, auxCandles) {
    const valid = computeRsiOnCandles(auxCandles).filter(
        (point) => point.rsi !== null,
    );

    if (!valid.length) {
        return primaryCandles.map(() => ({ rsi: null, prevRsi: null }));
    }

    const alignedValues = [];
    let ptr = 0;

    for (let i = 0; i < primaryCandles.length; i += 1) {
        const t = new Date(primaryCandles[i].date).getTime();

        while (ptr + 1 < valid.length && valid[ptr + 1].time <= t) {
            ptr += 1;
        }

        let rsi = null;

        if (valid[ptr].time <= t) {
            rsi = valid[ptr].rsi;
        } else {
            for (let j = ptr; j >= 0; j -= 1) {
                if (valid[j].time <= t) {
                    rsi = valid[j].rsi;
                    break;
                }
            }
        }

        alignedValues.push(rsi);
    }

    return alignedValues.map((rsi, index) => ({
        rsi,
        prevRsi: index > 0 ? alignedValues[index - 1] : null,
    }));
}

function emptyRsiRow() {
    return {
        rsi: null,
        prevRsi: null,
        rsi1m: null,
        prevRsi1m: null,
        rsi5m: null,
        prevRsi5m: null,
        rsi15m: null,
        prevRsi15m: null,
        hourlyRsi: null,
        prevHourlyRsi: null,
    };
}

function applyRsiInterval(row, interval, rsiData) {
    const mapping = INTERVAL_TO_RSI[interval];
    if (!mapping || !rsiData) return;

    row[mapping.field] = rsiData.rsi;
    row[mapping.prev] = rsiData.prevRsi;
}

function buildBacktestIndicators(
    primaryCandles,
    primaryInterval = "1d",
    auxiliaryCandles = {},
) {
    const closes = primaryCandles.map((c) => c.close);
    const ema20Values = calculateEma(closes, 20);
    const ema50Values = calculateEma(closes, 50);
    const ema200Values = calculateEma(closes, 200);

    const intervalsNeeded = new Set([
        primaryInterval,
        ...Object.keys(auxiliaryCandles),
    ]);

    const rsiByInterval = {};

    intervalsNeeded.forEach((interval) => {
        if (interval === primaryInterval) {
            rsiByInterval[interval] = computeDirectRsiWithPrev(primaryCandles);
        } else if (auxiliaryCandles[interval]?.length) {
            rsiByInterval[interval] = alignRsiToPrimaryBars(
                primaryCandles,
                auxiliaryCandles[interval],
            );
        }
    });

    return primaryCandles.map((candle, index) => {
        const prev = index > 0 ? primaryCandles[index - 1] : null;

        const priceChange =
            prev && prev.close
                ? ((candle.close - prev.close) / prev.close) * 100
                : 0;

        const volumeChange =
            prev && prev.volume
                ? ((candle.volume - prev.volume) / prev.volume) * 100
                : null;

        const row = {
            ...emptyRsiRow(),
            date: candle.date,
            open: candle.open ?? candle.close,
            price: candle.close,
            close: candle.close,
            volume: candle.volume,
            change: priceChange,
            volumeChange,
            pe: 0,
            high52Pct: 0,
            low52Pct: 0,
            ema20: ema20Values[index] ?? null,
            prevEma20: index > 0 ? ema20Values[index - 1] ?? null : null,
            ema50: ema50Values[index] ?? null,
            prevEma50: index > 0 ? ema50Values[index - 1] ?? null : null,
            ema200: ema200Values[index] ?? null,
            prevEma200: index > 0 ? ema200Values[index - 1] ?? null : null,
        };

        intervalsNeeded.forEach((interval) => {
            applyRsiInterval(row, interval, rsiByInterval[interval]?.[index]);
        });

        return row;
    });
}

async function fetchBacktestCandles(symbol, period, strategy) {
    const config = resolveBacktestConfig(strategy, period);

    const primaryChart = await fetchChart(
        symbol,
        config.yahooInterval,
        config.effectiveDays,
    );

    const candles = primaryChart.quotes.filter(
        (q) => q.close !== null && q.close !== undefined,
    );

    const auxiliaryCandles = {};

    await Promise.all(
        config.requiredIntervals
            .filter((interval) => interval !== config.interval)
            .map(async (interval) => {
                const intConfig = INTERVAL_CONFIG[interval];
                const days = Math.min(config.effectiveDays, intConfig.maxDays);
                const chart = await fetchChart(symbol, intConfig.yahoo, days);

                auxiliaryCandles[interval] = chart.quotes.filter(
                    (q) => q.close !== null && q.close !== undefined,
                );
            }),
    );

    return { candles, auxiliaryCandles, config };
}

function describeCondition(condition) {
    const right =
        condition.compareType === "indicator"
            ? condition.value
            : condition.value;
    return `${condition.indicator} ${condition.operator} ${right}`;
}

function verifyTradeSignal(data, index, conditions, type) {
    if (index <= 0 || index >= data.length) {
        return { confirmed: false, detail: "Index out of range" };
    }

    const current = data[index];
    const previous = data[index - 1];
    const fired = evaluateStrategy(
        current,
        previous,
        conditions,
        conditions.logic || "AND",
    );

    return {
        confirmed: fired,
        detail: fired
            ? `Signal confirmed on ${new Date(current.date).toISOString()}`
            : `Signal NOT confirmed on ${new Date(current.date).toISOString()}`,
        bar: {
            date: current.date,
            close: current.close,
            open: current.open,
        },
    };
}

function computeStreaks(trades) {
    let longestWin = 0;
    let longestLoss = 0;
    let currentWin = 0;
    let currentLoss = 0;

    trades.forEach((trade) => {
        if (trade.returnPct > 0) {
            currentWin += 1;
            currentLoss = 0;
            longestWin = Math.max(longestWin, currentWin);
        } else {
            currentLoss += 1;
            currentWin = 0;
            longestLoss = Math.max(longestLoss, currentLoss);
        }
    });

    return { longestWin, longestLoss };
}

function buildEquityCurve(candles, trades, capital) {
    const curve = [];
    const firstOpen = candles[0]?.open ?? candles[0]?.close ?? 1;
    let realizedEquity = capital;
    let tradeIdx = 0;
    let openTrade = null;

    candles.forEach((candle) => {
        const candleTime = new Date(candle.date).getTime();

        if (
            openTrade &&
            new Date(openTrade.exitDate).getTime() === candleTime
        ) {
            realizedEquity += openTrade.profit;
            openTrade = null;
            tradeIdx += 1;
        }

        while (
            tradeIdx < trades.length &&
            new Date(trades[tradeIdx].entryDate).getTime() === candleTime &&
            !openTrade
        ) {
            openTrade = trades[tradeIdx];
        }

        const close = candle.close ?? candle.open;
        const buyHoldEquity = capital * (close / firstOpen);

        let strategyEquity = realizedEquity;

        if (openTrade) {
            strategyEquity =
                realizedEquity *
                (close / openTrade.entryPrice);
        }

        curve.push({
            date: candle.date,
            equity: Number(strategyEquity.toFixed(2)),
            buyHoldEquity: Number(buyHoldEquity.toFixed(2)),
            startingCapital: capital,
            returnPct: Number(
                (((strategyEquity - capital) / capital) * 100).toFixed(2),
            ),
            buyHoldReturnPct: Number(
                (((buyHoldEquity - capital) / capital) * 100).toFixed(2),
            ),
        });
    });

    return curve;
}

function trimEquityCurveToTradeWindow(equityCurve, trades) {
    if (!equityCurve?.length || !trades?.length) {
        return equityCurve;
    }

    const firstEntry = new Date(trades[0].entryDate).getTime();
    const lastExit = new Date(trades[trades.length - 1].exitDate).getTime();

    let startIdx = 0;

    for (let i = 0; i < equityCurve.length; i += 1) {
        if (new Date(equityCurve[i].date).getTime() >= firstEntry) {
            startIdx = Math.max(0, i - 1);
            break;
        }
    }

    let endIdx = equityCurve.length - 1;

    for (let i = equityCurve.length - 1; i >= 0; i -= 1) {
        if (new Date(equityCurve[i].date).getTime() <= lastExit) {
            endIdx = i;
            break;
        }
    }

    if (startIdx >= endIdx) {
        return equityCurve;
    }

    return equityCurve.slice(startIdx, endIdx + 1);
}

function runBacktestSimulation({
    strategy,
    candles,
    capital,
    interval = "1d",
    auxiliaryCandles = {},
    validationMode = false,
}) {
    const data = buildBacktestIndicators(candles, interval, auxiliaryCandles);
    const trades = [];
    const auditLog = [];
    const signalLogs = [];

    const signalStats = {
        entrySignalsFound: 0,
        entriesExecuted: 0,
        exitSignalsFound: 0,
        exitsExecuted: 0,
        ignoredEntrySignals: 0,
        ignoredExitSignals: 0,
        skippedEntryNoNextBar: 0,
        skippedExitNoNextBar: 0,
    };

    let equity = capital;
    let inPosition = false;
    let entryPrice = 0;
    let entryDate = null;
    let entrySignalIndex = null;
    let pendingEntryFromBar = null;
    let pendingExitFromBar = null;
    let pendingExitReason = null;
    let pendingExitSignalIndex = null;

    const entryConditions = strategy.entryConditions?.length
        ? strategy.entryConditions
        : strategy.conditions || [];

    const exitConditions = strategy.exitConditions || [];
    const startIndex = getBacktestStartIndex(entryConditions, exitConditions);

    for (let i = startIndex; i < data.length; i += 1) {
        const candle = candles[i];

        if (pendingEntryFromBar !== null && i === pendingEntryFromBar + 1) {
            entryPrice = candle.open ?? candle.close;
            entryDate = candle.date;
            inPosition = true;
            signalStats.entriesExecuted += 1;
            pendingEntryFromBar = null;

            signalLogs.push({
                type: "ENTRY_EXECUTED",
                signalBar: data[entrySignalIndex]?.date,
                executionBar: entryDate,
                price: entryPrice,
            });
        }

        if (
            pendingExitFromBar !== null &&
            i === pendingExitFromBar + 1 &&
            inPosition
        ) {
            const exitPrice = candle.open ?? candle.close;
            const exitDate = candle.date;
            const reason = pendingExitReason;
            const returnPct = ((exitPrice - entryPrice) / entryPrice) * 100;
            const profit = equity * (returnPct / 100);
            equity += profit;

            const entryVerification = verifyTradeSignal(
                data,
                entrySignalIndex,
                entryConditions,
            );
            const exitVerification = verifyTradeSignal(
                data,
                pendingExitSignalIndex,
                exitConditions.length
                    ? exitConditions
                    : [{ indicator: reason, operator: reason, value: "" }],
            );

            const trade = {
                entryDate,
                exitDate,
                signalEntryDate: data[entrySignalIndex]?.date,
                signalExitDate: data[pendingExitSignalIndex]?.date,
                entryPrice: Number(entryPrice.toFixed(2)),
                exitPrice: Number(exitPrice.toFixed(2)),
                returnPct: Number(returnPct.toFixed(2)),
                pnl: Number(profit.toFixed(2)),
                pnlPercent: Number(returnPct.toFixed(2)),
                profit: Number(profit.toFixed(2)),
                reason,
                holdingDays: Math.max(
                    0,
                    Math.round(
                        (new Date(exitDate) - new Date(entryDate)) /
                            (1000 * 60 * 60 * 24),
                    ),
                ),
                entryConfirmed: entryVerification.confirmed,
                exitConfirmed: exitVerification.confirmed,
            };

            trades.push(trade);
            signalStats.exitsExecuted += 1;

            if (validationMode) {
                auditLog.push({
                    tradeNumber: trades.length,
                    entry: {
                        date: trade.entryDate,
                        price: trade.entryPrice,
                        signalDate: trade.signalEntryDate,
                        reason: entryConditions.map(describeCondition).join(" AND "),
                    },
                    exit: {
                        date: trade.exitDate,
                        price: trade.exitPrice,
                        signalDate: trade.signalExitDate,
                        reason: trade.reason,
                    },
                    pnl: trade.pnl,
                    returnPct: trade.returnPct,
                    confirmed: trade.entryConfirmed && trade.exitConfirmed,
                });
            }

            signalLogs.push({
                type: "EXIT_EXECUTED",
                signalBar: data[pendingExitSignalIndex]?.date,
                executionBar: exitDate,
                price: exitPrice,
                reason,
            });

            inPosition = false;
            entryPrice = 0;
            entryDate = null;
            entrySignalIndex = null;
            pendingExitFromBar = null;
            pendingExitReason = null;
            pendingExitSignalIndex = null;
        }

        if (i >= data.length - 1) {
            continue;
        }

        const current = data[i];
        const previous = data[i - 1];

        if (!inPosition && pendingEntryFromBar === null) {
            const entrySignal = evaluateStrategy(
                current,
                previous,
                entryConditions,
                strategy.logic || "AND",
            );

            if (entrySignal) {
                signalStats.entrySignalsFound += 1;
                pendingEntryFromBar = i;
                entrySignalIndex = i;

                signalLogs.push({
                    type: "ENTRY_SIGNAL",
                    bar: current.date,
                    conditions: entryConditions.map(describeCondition),
                });
            }

            continue;
        }

        if (inPosition && pendingExitFromBar === null) {
            const stopLossPct = Number(strategy.stopLoss) || 0;
            const targetPct = Number(strategy.target) || 0;
            const stopLossPrice =
                stopLossPct > 0 ? entryPrice * (1 - stopLossPct / 100) : null;
            const targetPrice =
                targetPct > 0 ? entryPrice * (1 + targetPct / 100) : null;

            const stopLossHit =
                stopLossPrice !== null && current.close <= stopLossPrice;
            const targetHit =
                targetPrice !== null && current.close >= targetPrice;
            const exitSignal =
                exitConditions.length > 0 &&
                evaluateStrategy(
                    current,
                    previous,
                    exitConditions,
                    strategy.logic || "AND",
                );

            if (exitSignal) {
                signalStats.exitSignalsFound += 1;
            }

            if (!stopLossHit && !targetHit && !exitSignal) {
                continue;
            }

            let reason = "Strategy Exit";

            if (stopLossHit) reason = "Stop Loss Hit";
            else if (targetHit) reason = "Target Hit";

            pendingExitFromBar = i;
            pendingExitReason = reason;
            pendingExitSignalIndex = i;

            signalLogs.push({
                type: "EXIT_SIGNAL",
                bar: current.date,
                reason,
                conditions: exitConditions.map(describeCondition),
            });
        } else if (!inPosition && pendingEntryFromBar !== null) {
            signalStats.ignoredEntrySignals += 0;
        }
    }

    if (validationMode && signalStats.entrySignalsFound > signalStats.entriesExecuted) {
        signalStats.skippedEntryNoNextBar =
            signalStats.entrySignalsFound - signalStats.entriesExecuted;
    }

    if (validationMode && signalStats.exitSignalsFound > signalStats.exitsExecuted) {
        signalStats.skippedExitNoNextBar =
            signalStats.exitSignalsFound - signalStats.exitsExecuted;
    }

    const returns = trades.map((t) => t.returnPct);
    const wins = trades.filter((t) => t.returnPct > 0);
    const losses = trades.filter((t) => t.returnPct <= 0);
    const streaks = computeStreaks(trades);

    const sumWins = wins.reduce((s, t) => s + t.profit, 0);
    const sumLosses = losses.reduce((s, t) => s + Math.abs(t.profit), 0);

    const profitFactor =
        sumLosses > 0
            ? Number((sumWins / sumLosses).toFixed(2))
            : sumWins > 0
              ? Infinity
              : 0;

    const fullEquityCurve = buildEquityCurve(candles, trades, capital);
    const equityCurve = trimEquityCurveToTradeWindow(fullEquityCurve, trades);

    let maxDrawdown = 0;
    let peak = -Infinity;

    fullEquityCurve.forEach((point) => {
        if (point.equity > peak) peak = point.equity;
        const dd = peak > 0 ? ((peak - point.equity) / peak) * 100 : 0;
        if (dd > maxDrawdown) maxDrawdown = dd;
    });

    const firstClose = candles[0]?.close ?? candles[0]?.open ?? 1;
    const lastClose =
        candles[candles.length - 1]?.close ??
        candles[candles.length - 1]?.open ??
        firstClose;
    const buyAndHoldReturn = Number(
        (((lastClose - firstClose) / firstClose) * 100).toFixed(2),
    );
    const totalReturn = Number((((equity - capital) / capital) * 100).toFixed(2));
    const outperformance = Number((totalReturn - buyAndHoldReturn).toFixed(2));

    const summary = {
        totalTrades: trades.length,
        winningTrades: wins.length,
        losingTrades: losses.length,
        winRate: trades.length
            ? Number(((wins.length / trades.length) * 100).toFixed(2))
            : 0,
        avgReturn: trades.length
            ? Number(
                  (returns.reduce((a, b) => a + b, 0) / trades.length).toFixed(
                      2,
                  ),
              )
            : 0,
        averageTrade: trades.length
            ? Number(
                  (returns.reduce((a, b) => a + b, 0) / trades.length).toFixed(
                      2,
                  ),
              )
            : 0,
        bestTrade: returns.length ? Math.max(...returns) : 0,
        worstTrade: returns.length ? Math.min(...returns) : 0,
        finalCapital: Number(equity.toFixed(2)),
        totalReturn,
        netProfit: Number((equity - capital).toFixed(2)),
        profitFactor,
        averageWin: wins.length
            ? Number(
                  (
                      wins.reduce((s, t) => s + t.returnPct, 0) / wins.length
                  ).toFixed(2),
              )
            : 0,
        averageLoss: losses.length
            ? Number(
                  (
                      losses.reduce((s, t) => s + t.returnPct, 0) /
                      losses.length
                  ).toFixed(2),
              )
            : 0,
        maxDrawdown: Number(maxDrawdown.toFixed(2)),
        largestWinningTrade: returns.length ? Math.max(...returns) : 0,
        largestLosingTrade: returns.length ? Math.min(...returns) : 0,
        longestWinningStreak: streaks.longestWin,
        longestLosingStreak: streaks.longestLoss,
        averageHoldingDays: trades.length
            ? Number(
                  (
                      trades.reduce((s, t) => s + (t.holdingDays || 0), 0) /
                      trades.length
                  ).toFixed(1),
              )
            : 0,
        buyAndHoldReturn,
        outperformance,
        outperformancePct:
            buyAndHoldReturn !== 0
                ? Number(
                      (
                          ((totalReturn - buyAndHoldReturn) /
                              Math.abs(buyAndHoldReturn)) *
                          100
                      ).toFixed(2),
                  )
                : totalReturn,
        candleCount: candles.length,
        startingCapital: capital,
    };

    if (validationMode) {
        // auditLog populated per trade above
    }

    const tradeMarkers = trades.flatMap((trade, index) => [
        {
            date: trade.entryDate,
            price: trade.entryPrice,
            type: "buy",
            tradeNumber: index + 1,
            reason: "Entry",
        },
        {
            date: trade.exitDate,
            price: trade.exitPrice,
            type: "sell",
            tradeNumber: index + 1,
            reason: trade.reason,
        },
    ]);

    return {
        summary,
        trades,
        equityCurve,
        fullEquityCurve,
        signalStats,
        signalLogs: validationMode ? signalLogs : undefined,
        auditLog: validationMode ? auditLog : undefined,
        tradeMarkers,
    };
}

module.exports = {
    buildBacktestIndicators,
    fetchBacktestCandles,
    runBacktestSimulation,
    trimEquityCurveToTradeWindow,
    getStrategyInterval,
    getRequiredRsiIntervals,
    resolveBacktestConfig,
    INTERVAL_CONFIG,
};
