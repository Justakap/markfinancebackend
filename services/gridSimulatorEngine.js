/**
 * Grid Trading Simulator — pure, deterministic crossing/accounting engine.
 *
 * PAPER TRADING ONLY. Nothing in this file (or anything that calls it)
 * places a real broker order. Every "fill" is a simulated bookkeeping
 * entry against virtual cash/holdings.
 *
 * Design (see .claude/state/DECISIONS.md ADR-021 for the full writeup):
 *
 * - A fixed grid is anchored to `config.referencePrice`, spaced every
 *   `config.gridInterval`. Level index `n` (any nonzero integer) has
 *   price `referencePrice + n*gridInterval`. Negative `n` = BUY level
 *   (below reference), positive `n` = SELL level (above reference).
 * - A BUY level triggers only on a DOWNWARD crossing while "armed"; a
 *   SELL level triggers only on an UPWARD crossing while "armed". The
 *   opposite-direction crossing of a level re-arms it (does not trade) —
 *   this is what lets a level participate again in a later oscillation
 *   without producing a duplicate fill from the same one-way move.
 * - One price update (one tick, or one open-after-gap event) can cross
 *   several levels at once (e.g. an overnight gap). Every level crossed
 *   in that single update fills at the SAME actual event price — never
 *   at its own (possibly-skipped) grid price. The triggering grid level
 *   and the simulated fill price are always recorded separately.
 * - A buy/sell that can't be filled in full (insufficient cash/holdings)
 *   fills the affordable/available remainder (if >=1 share) or is fully
 *   skipped, and the level is disarmed either way — it does not retry
 *   the unfilled remainder on subsequent ticks while price stays on the
 *   same side. It only becomes eligible again after a genuine opposite-
 *   direction re-arming crossing. This is the deterministic retry policy
 *   the spec requires: no surprise duplicate/repeated purchases.
 * - Cost basis: weighted-average cost on buys; realized P&L computed
 *   against that average cost on sells; average cost resets to 0 only
 *   when holdings return to exactly 0.
 * - Optional `commissionPct`/`slippagePct` (same naming/semantics as the
 *   existing backtest/live engines' two-knob cost model — see ADR-019)
 *   default to 0, i.e. fills are exact at the event price unless
 *   explicitly configured otherwise. This model has the same disclosed
 *   limitation as ADR-019: no STT/exchange/GST/SEBI/stamp-duty modeling.
 */

const PRICE_SCALE = 100; // 2 decimal places (paise-level precision)

function isFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
}

function toCents(price) {
    // A tiny epsilon guards against binary floating-point representation
    // error landing a true .5-paise boundary just under it (e.g. 97*1.005
    // evaluates to 97.48499999999999 in IEEE754, which would otherwise
    // round down to 9748 instead of the mathematically correct 9749).
    return Math.round(price * PRICE_SCALE + 1e-9);
}

function roundPrice(price) {
    return toCents(price) / PRICE_SCALE;
}

/** Validates a grid configuration. Returns { valid, errors }. Never throws. */
function validateGridConfig(config = {}) {
    const errors = [];

    if (!isFiniteNumber(config.referencePrice) || config.referencePrice <= 0) {
        errors.push("referencePrice must be a positive number");
    } else if (toCents(config.referencePrice) / PRICE_SCALE !== roundPrice(config.referencePrice)) {
        // unreachable in practice (roundPrice always resolves), kept for clarity
    }

    if (!isFiniteNumber(config.gridInterval) || config.gridInterval <= 0) {
        errors.push("gridInterval must be a positive number");
    } else if (toCents(config.gridInterval) < 1) {
        errors.push("gridInterval is too small to represent at paise precision");
    }

    if (!Number.isInteger(config.quantityPerLevel) || config.quantityPerLevel < 1) {
        errors.push("quantityPerLevel must be a positive integer");
    }

    if (!isFiniteNumber(config.startingCapital) || config.startingCapital <= 0) {
        errors.push("startingCapital must be a positive number");
    }

    if (
        config.maxPositionSize !== undefined &&
        config.maxPositionSize !== null &&
        (!Number.isInteger(config.maxPositionSize) || config.maxPositionSize < 1)
    ) {
        errors.push("maxPositionSize must be a positive integer when provided");
    }

    if (
        config.commissionPct !== undefined &&
        (!isFiniteNumber(config.commissionPct) || config.commissionPct < 0)
    ) {
        errors.push("commissionPct must be a non-negative number when provided");
    }

    if (
        config.slippagePct !== undefined &&
        (!isFiniteNumber(config.slippagePct) || config.slippagePct < 0)
    ) {
        errors.push("slippagePct must be a non-negative number when provided");
    }

    const startingHoldings = config.startingHoldings ?? 0;
    if (!Number.isInteger(startingHoldings) || startingHoldings < 0) {
        errors.push("startingHoldings must be a non-negative integer when provided");
    } else if (startingHoldings > 0) {
        // Required precisely when there's an existing inventory to establish
        // a cost basis for — never required (and never silently fabricated)
        // when the session starts flat.
        if (!isFiniteNumber(config.startingAvgCost) || config.startingAvgCost <= 0) {
            errors.push("startingAvgCost is required and must be a positive number when startingHoldings > 0");
        }
    }

    return { valid: errors.length === 0, errors };
}

function normalizeConfig(config) {
    return {
        referencePrice: roundPrice(config.referencePrice),
        gridInterval: roundPrice(config.gridInterval),
        quantityPerLevel: config.quantityPerLevel,
        startingCapital: roundPrice(config.startingCapital),
        maxPositionSize: config.maxPositionSize ?? null,
        commissionPct: config.commissionPct ?? 0,
        slippagePct: config.slippagePct ?? 0,
        startingHoldings: Math.max(0, Math.trunc(config.startingHoldings || 0)),
        startingAvgCost: config.startingHoldings > 0 ? roundPrice(config.startingAvgCost) : 0,
    };
}

function levelPrice(config, n) {
    return roundPrice(config.referencePrice + n * config.gridInterval);
}

/**
 * `config.referenceCapturedAt` (ISO string or Date), when provided, seeds
 * the initial crossing/dedup watermark directly from the fresh quote
 * captured at session creation — "at session creation, initialize the
 * crossing watermark using the initial reference quote," not left to an
 * implicit null-fallback. `lastPrice` is likewise seeded to the anchor
 * itself (`referencePrice`) rather than null, matching the same intent.
 */
function createInitialGridState(config) {
    const normalized = normalizeConfig(config);
    return {
        cash: normalized.startingCapital,
        holdings: normalized.startingHoldings,
        avgCost: normalized.startingAvgCost,
        realizedPnL: 0,
        lastPrice: normalized.referencePrice,
        lastEventTimestamp: config.referenceCapturedAt ? new Date(config.referenceCapturedAt).toISOString() : null,
        levelArmed: {},
        sequence: 0,
    };
}

/**
 * Finds every grid level crossed moving from prevPrice to newPrice
 * (inclusive at BOTH ends). Returns level indices in actual traversal
 * order (closest-to-prev first), which matters because cash/holdings
 * constraints are applied sequentially within one event.
 *
 * Inclusive-both-ends is deliberate: if a prior event landed exactly on a
 * level (disarming it), the very next event moving away from it in the
 * OPPOSITE direction must still see that level as "crossed" so it can
 * re-arm — otherwise a price that touches a level exactly and bounces
 * off it could never re-arm. The resulting one-tick overlap at an exact
 * boundary (the same level appearing in two consecutive opposite-
 * direction calls) is harmless: the caller's armed-state check is the
 * only thing that decides whether a trade fires, so a level that is
 * already disarmed and reappears in a same-direction continuation simply
 * does nothing.
 */
function findCrossedLevels(config, prevPriceCents, newPriceCents) {
    if (prevPriceCents === newPriceCents) return [];

    const direction = newPriceCents > prevPriceCents ? "up" : "down";
    const intervalCents = toCents(config.gridInterval);
    const referenceCents = toCents(config.referencePrice);

    const loCents = Math.min(prevPriceCents, newPriceCents);
    const hiCents = Math.max(prevPriceCents, newPriceCents);

    const nLo = Math.floor((loCents - referenceCents) / intervalCents) - 1;
    const nHi = Math.ceil((hiCents - referenceCents) / intervalCents) + 1;

    const levels = [];
    for (let n = nLo; n <= nHi; n += 1) {
        if (n === 0) continue;
        const lCents = referenceCents + n * intervalCents;
        if (lCents >= loCents && lCents <= hiCents) levels.push(n);
    }

    levels.sort((a, b) => (direction === "down" ? b - a : a - b));
    return levels;
}

function isArmed(levelArmed, n) {
    return levelArmed[n] !== false;
}

function applyBuy({ config, cash, holdings, avgCost, fillPrice, level, levelPriceValue }) {
    const slippageMultiplier = 1 + config.slippagePct / 100;
    const effectivePrice = roundPrice(fillPrice * slippageMultiplier);
    const unitCost = roundPrice(effectivePrice * (1 + config.commissionPct / 100));

    const targetQty = config.quantityPerLevel;
    const affordableByCash = unitCost > 0 ? Math.floor(cash / unitCost) : 0;
    const remainingCapacity = config.maxPositionSize != null ? Math.max(0, config.maxPositionSize - holdings) : Infinity;
    const qty = Math.max(0, Math.min(targetQty, affordableByCash, remainingCapacity));

    if (qty < 1) {
        return {
            cash,
            holdings,
            avgCost,
            realizedPnLDelta: 0,
            trade: {
                type: "BUY",
                level,
                levelPrice: levelPriceValue,
                fillPrice,
                effectivePrice,
                qtyRequested: targetQty,
                qtyFilled: 0,
                qtySkipped: targetQty,
                reason: affordableByCash < 1 ? "insufficient_cash" : "max_position_size_reached",
                realizedPnLDelta: 0,
            },
        };
    }

    const cost = roundPrice(qty * unitCost);
    const newHoldings = holdings + qty;
    const newAvgCost = roundPrice((avgCost * holdings + cost) / newHoldings);
    const newCash = roundPrice(cash - cost);

    return {
        cash: newCash,
        holdings: newHoldings,
        avgCost: newAvgCost,
        realizedPnLDelta: 0,
        trade: {
            type: "BUY",
            level,
            levelPrice: levelPriceValue,
            fillPrice,
            effectivePrice,
            qtyRequested: targetQty,
            qtyFilled: qty,
            qtySkipped: targetQty - qty,
            reason: qty < targetQty ? "insufficient_cash_partial" : null,
            realizedPnLDelta: 0,
        },
    };
}

function applySell({ config, cash, holdings, avgCost, realizedPnL, fillPrice, level, levelPriceValue }) {
    const slippageMultiplier = 1 - config.slippagePct / 100;
    const effectivePrice = roundPrice(fillPrice * slippageMultiplier);
    const unitProceeds = roundPrice(effectivePrice * (1 - config.commissionPct / 100));

    const targetQty = config.quantityPerLevel;
    const qty = Math.max(0, Math.min(targetQty, holdings));

    if (qty < 1) {
        return {
            cash,
            holdings,
            avgCost,
            realizedPnL,
            trade: {
                type: "SELL",
                level,
                levelPrice: levelPriceValue,
                fillPrice,
                effectivePrice,
                qtyRequested: targetQty,
                qtyFilled: 0,
                qtySkipped: targetQty,
                reason: "insufficient_holdings",
                realizedPnLDelta: 0,
            },
        };
    }

    const proceeds = roundPrice(qty * unitProceeds);
    const realizedPnLDelta = roundPrice(qty * (unitProceeds - avgCost));
    const newHoldings = holdings - qty;
    const newCash = roundPrice(cash + proceeds);
    const newAvgCost = newHoldings === 0 ? 0 : avgCost;
    const newRealizedPnL = roundPrice(realizedPnL + realizedPnLDelta);

    return {
        cash: newCash,
        holdings: newHoldings,
        avgCost: newAvgCost,
        realizedPnL: newRealizedPnL,
        trade: {
            type: "SELL",
            level,
            levelPrice: levelPriceValue,
            fillPrice,
            effectivePrice,
            qtyRequested: targetQty,
            qtyFilled: qty,
            qtySkipped: targetQty - qty,
            reason: qty < targetQty ? "insufficient_holdings_partial" : null,
            realizedPnLDelta,
        },
    };
}

/**
 * Processes exactly one price update against the current grid state.
 * Pure function — no DB, no I/O, no mutation of inputs. Returns
 * { state, trades, skipped, gapFill }.
 *
 * `price` is the actual observed price for this event (a live tick, or
 * the real opening price after a gap) — never a grid level's own price
 * unless they happen to coincide.
 */
function processPriceUpdate({ config: rawConfig, state, price, eventTimestamp }) {
    const config = normalizeConfig(rawConfig);

    if (!isFiniteNumber(price) || price <= 0) {
        return { state, trades: [], skipped: true, reason: "invalid_price" };
    }
    if (!eventTimestamp || Number.isNaN(new Date(eventTimestamp).getTime())) {
        return { state, trades: [], skipped: true, reason: "invalid_timestamp" };
    }

    const eventMs = new Date(eventTimestamp).getTime();
    if (state.lastEventTimestamp != null) {
        const lastMs = new Date(state.lastEventTimestamp).getTime();
        if (eventMs <= lastMs) {
            return { state, trades: [], skipped: true, reason: "duplicate_or_out_of_order_event" };
        }
    }

    const roundedPrice = roundPrice(price);
    const prevPrice = state.lastPrice == null ? config.referencePrice : state.lastPrice;

    if (roundedPrice === prevPrice) {
        return {
            state: { ...state, lastPrice: roundedPrice, lastEventTimestamp: eventTimestamp, sequence: state.sequence + 1 },
            trades: [],
            skipped: false,
            gapFill: false,
        };
    }

    const direction = roundedPrice < prevPrice ? "down" : "up";
    const crossedLevels = findCrossedLevels(config, toCents(prevPrice), toCents(roundedPrice));

    let { cash, holdings, avgCost, realizedPnL } = state;
    const levelArmed = { ...state.levelArmed };
    const trades = [];

    crossedLevels.forEach((n) => {
        const levelPriceValue = levelPrice(config, n);
        const isBuyLevel = n < 0;
        const isSellLevel = n > 0;

        if (direction === "down") {
            if (isBuyLevel && isArmed(levelArmed, n)) {
                const result = applyBuy({ config, cash, holdings, avgCost, fillPrice: roundedPrice, level: n, levelPriceValue });
                cash = result.cash;
                holdings = result.holdings;
                avgCost = result.avgCost;
                levelArmed[n] = false;
                trades.push(result.trade);
            } else if (isSellLevel) {
                levelArmed[n] = true;
            }
        } else {
            if (isSellLevel && isArmed(levelArmed, n)) {
                const result = applySell({ config, cash, holdings, avgCost, realizedPnL, fillPrice: roundedPrice, level: n, levelPriceValue });
                cash = result.cash;
                holdings = result.holdings;
                avgCost = result.avgCost;
                realizedPnL = result.realizedPnL;
                levelArmed[n] = false;
                trades.push(result.trade);
            } else if (isBuyLevel) {
                levelArmed[n] = true;
            }
        }
    });

    const newState = {
        cash,
        holdings,
        avgCost,
        realizedPnL,
        lastPrice: roundedPrice,
        lastEventTimestamp: eventTimestamp,
        levelArmed,
        sequence: state.sequence + 1,
    };

    return { state: newState, trades, skipped: false, gapFill: crossedLevels.length > 1 };
}

/**
 * Replays a batch of the engine's already-decided trades (in their
 * original order) over the pre-update state to recover each trade's own
 * running cash/holdings/avgCost snapshot for the ledger — using only each
 * trade's own recorded fields (qtyFilled/effectivePrice/type) plus the
 * session's commissionPct, the exact same arithmetic applyBuy/applySell
 * already used internally. This never re-decides anything
 * (quantities/prices are already final) — it only reconstructs the audit
 * trail the pure engine's return value doesn't carry per-trade. Shared by
 * both the live simulator (gridSimulatorService.js) and the historical
 * replay engine (gridBacktestEngine.js) so the ledger's running-balance
 * math is never duplicated.
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

function computePortfolioMetrics(state, currentPrice) {
    const price = isFiniteNumber(currentPrice) ? roundPrice(currentPrice) : null;
    const unrealizedPnL = price != null && state.holdings > 0 ? roundPrice(state.holdings * (price - state.avgCost)) : 0;
    const marketValue = price != null ? roundPrice(state.holdings * price) : null;
    const equity = marketValue != null ? roundPrice(state.cash + marketValue) : null;

    return {
        cash: state.cash,
        holdings: state.holdings,
        avgCost: state.avgCost,
        realizedPnL: state.realizedPnL,
        unrealizedPnL,
        marketValue,
        equity,
    };
}

module.exports = {
    PRICE_SCALE,
    roundPrice,
    toCents,
    validateGridConfig,
    normalizeConfig,
    levelPrice,
    createInitialGridState,
    findCrossedLevels,
    processPriceUpdate,
    computePortfolioMetrics,
    annotateRunningState,
};
