/**
 * Grid Trading Simulator — pure, deterministic crossing/accounting engine.
 *
 * PAPER TRADING ONLY. Nothing in this file (or anything that calls it)
 * places a real broker order. Every "fill" is a simulated bookkeeping
 * entry against virtual cash/holdings.
 *
 * Design (see .claude/state/DECISIONS.md ADR-021 for the original fixed-
 * grid design and ADR-031 for the trailing/rebasing redesign below):
 *
 * - `config.referencePrice` ("Initial Reference") is the immutable anchor
 *   captured once at session creation — kept forever for audit/display,
 *   but it does NOT define the tradeable grid levels once trading begins.
 * - `state.activeReference` ("Active Reference") is the anchor that
 *   ACTUALLY defines the next tradeable levels: `activeReference +
 *   n*gridInterval`. It starts equal to `referencePrice` and REBASES to
 *   the last grid level reached after EVERY crossing — whether that
 *   crossing's trade filled, partially filled, or was fully skipped for
 *   insufficient cash/holdings. Example: reference 320, interval 3, price
 *   moves 320 -> 329 (crossing 323/326/329, all skipped for insufficient
 *   holdings) -> activeReference becomes 329. A later pullback to 326 is
 *   now a BUY (326 = 329 - interval), not a dead zone below the original
 *   323/326/329 sell levels. The lattice itself (every point
 *   `referencePrice + k*gridInterval` for any integer k) never shifts
 *   phase — rebasing only changes which lattice point is "zero" for the
 *   NEXT crossing, so `activeReference` is always itself a lattice point.
 * - Because the reference always rebases to wherever price last crossed,
 *   there is no separate "armed/disarmed" concept anymore: every crossing
 *   is evaluated fresh against the current `activeReference`, and
 *   direction alone decides the action — a downward crossing is always a
 *   BUY attempt, an upward crossing is always a SELL attempt (relative to
 *   whatever the active reference currently is).
 * - One price update (one tick, or one open-after-gap event) can cross
 *   several levels at once (e.g. an overnight gap). Every level crossed
 *   in that single update fills at the SAME actual event price — never
 *   at its own (possibly-skipped) grid price. The triggering grid level
 *   and the simulated fill price are always recorded separately; the
 *   active reference rebases to the LAST (farthest) level reached in that
 *   one update, not to the raw observed price.
 * - A buy/sell that can't be filled in full (insufficient cash/holdings)
 *   fills the affordable/available remainder (if >=1 share) or is fully
 *   skipped — either way the reference still rebases to that level, so
 *   the position can be revisited on the very next qualifying move in
 *   either direction. This is the deterministic policy the spec requires.
 * - Cost basis: FIFO lot queue (ADR-032). Every filled BUY pushes a
 *   {qty, price} lot onto the end of `state.lots`. Every filled SELL
 *   consumes lots from the FRONT of the queue (oldest first) until the
 *   sold quantity is covered, possibly spanning multiple lots at
 *   different prices; realized P&L for that sell is the sum, across
 *   however many lots it consumes, of `consumedQty * (unitProceeds -
 *   thatLot'sOwnPrice)` — never a single blended average. `state.avgCost`
 *   is kept as a DERIVED display value only (the weighted average of
 *   whatever lots currently remain) — it is never itself used to compute
 *   realized P&L; unrealized P&L (computePortfolioMetrics) legitimately
 *   uses it since mark-to-market valuation of the remaining position is
 *   the same number either way lots are represented. avgCost is 0 when
 *   the lot queue is empty (holdings back to exactly 0).
 * - Optional asymmetric spacing (ADR-034): `config.sellVariance`, when set,
 *   is the spacing used for upward (SELL) crossings, while `gridInterval`
 *   remains the spacing for downward (BUY) crossings. `sellVariance` is
 *   null by default, meaning the sell side simply mirrors `gridInterval` —
 *   the original symmetric behavior. Since one price update moves in only
 *   one direction, only one of the two variances is ever relevant per call.
 * - Optional asymmetric quantity (ADR-035): `config.sellQuantityPerLevel`,
 *   when set, is the quantity used for SELL fills, while `quantityPerLevel`
 *   remains the quantity for BUY fills. Same null-means-mirror pattern as
 *   sellVariance.
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

    // sellVariance is optional — when absent/null, the sell side simply
    // mirrors gridInterval (the "buy variance"). When provided, it must be
    // just as valid as gridInterval itself.
    if (config.sellVariance !== undefined && config.sellVariance !== null) {
        if (!isFiniteNumber(config.sellVariance) || config.sellVariance <= 0) {
            errors.push("sellVariance must be a positive number when provided");
        } else if (toCents(config.sellVariance) < 1) {
            errors.push("sellVariance is too small to represent at paise precision");
        }
    }

    if (!Number.isInteger(config.quantityPerLevel) || config.quantityPerLevel < 1) {
        errors.push("quantityPerLevel must be a positive integer");
    }

    // sellQuantityPerLevel is optional — when absent/null, SELL fills simply
    // mirror quantityPerLevel (the "buy quantity"), same pattern as
    // sellVariance above.
    if (config.sellQuantityPerLevel !== undefined && config.sellQuantityPerLevel !== null) {
        if (!Number.isInteger(config.sellQuantityPerLevel) || config.sellQuantityPerLevel < 1) {
            errors.push("sellQuantityPerLevel must be a positive integer when provided");
        }
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
        // ADR-034: optional asymmetric sell-side spacing. null/absent means
        // "mirror gridInterval" — the sell side uses the exact same spacing
        // as the buy side, i.e. the original symmetric behavior.
        sellVariance: config.sellVariance != null ? roundPrice(config.sellVariance) : null,
        quantityPerLevel: config.quantityPerLevel,
        // ADR-035: optional asymmetric sell-side quantity, same mirror
        // pattern as sellVariance — null/absent means SELL fills use
        // quantityPerLevel too (the original symmetric behavior).
        sellQuantityPerLevel: config.sellQuantityPerLevel != null ? config.sellQuantityPerLevel : null,
        startingCapital: roundPrice(config.startingCapital),
        maxPositionSize: config.maxPositionSize ?? null,
        commissionPct: config.commissionPct ?? 0,
        slippagePct: config.slippagePct ?? 0,
        startingHoldings: Math.max(0, Math.trunc(config.startingHoldings || 0)),
        startingAvgCost: config.startingHoldings > 0 ? roundPrice(config.startingAvgCost) : 0,
    };
}

/** Level price relative to the IMMUTABLE initial reference — used only for
 *  display/audit (e.g. GridLevelsChart's static lattice lines), never for
 *  deciding crossings (see levelPriceFromReference for that). */
function levelPrice(config, n) {
    return roundPrice(config.referencePrice + n * config.gridInterval);
}

/** Level price relative to an explicit (possibly rebased) reference. */
function levelPriceFromReference(reference, gridInterval, n) {
    return roundPrice(reference + n * gridInterval);
}

/** Weighted-average cost across the current FIFO lot queue — a DISPLAY
 *  value only (see ADR-032); 0 when the queue is empty. */
function weightedAvgCost(lots) {
    const totalQty = lots.reduce((sum, lot) => sum + lot.qty, 0);
    if (totalQty <= 0) return 0;
    const totalCost = lots.reduce((sum, lot) => sum + lot.qty * lot.price, 0);
    return roundPrice(totalCost / totalQty);
}

/**
 * Consumes `qty` shares from the FRONT of the FIFO lot queue (oldest lots
 * first), computing realized P&L per lot at THAT lot's own purchase price
 * — never a blended average. Returns the remaining lots (after removing/
 * shrinking consumed ones) and the total realized P&L delta. Assumes
 * `qty` never exceeds the total quantity held across all lots (the caller
 * already clamps qty to `holdings` before calling this).
 */
function consumeLotsFifo(lots, qty, unitProceeds) {
    let remaining = qty;
    let realizedPnLDelta = 0;
    const newLots = [];
    let i = 0;
    for (; i < lots.length && remaining > 0; i += 1) {
        const lot = lots[i];
        const consumed = Math.min(lot.qty, remaining);
        realizedPnLDelta = roundPrice(realizedPnLDelta + consumed * (unitProceeds - lot.price));
        remaining -= consumed;
        if (consumed < lot.qty) {
            newLots.push({ qty: lot.qty - consumed, price: lot.price });
        }
    }
    for (; i < lots.length; i += 1) newLots.push(lots[i]);
    return { lots: newLots, realizedPnLDelta };
}

/**
 * `config.referenceCapturedAt` (ISO string or Date), when provided, seeds
 * the initial crossing/dedup watermark directly from the fresh quote
 * captured at session creation — "at session creation, initialize the
 * crossing watermark using the initial reference quote," not left to an
 * implicit null-fallback. `lastPrice` and `activeReference` are likewise
 * seeded to the anchor itself (`referencePrice`) rather than null,
 * matching the same intent.
 */
function createInitialGridState(config) {
    const normalized = normalizeConfig(config);
    const lots = normalized.startingHoldings > 0 ? [{ qty: normalized.startingHoldings, price: normalized.startingAvgCost }] : [];
    return {
        cash: normalized.startingCapital,
        holdings: normalized.startingHoldings,
        lots, // FIFO cost-basis queue (ADR-032) — starting inventory seeds one lot
        avgCost: normalized.startingAvgCost, // derived display value, kept in sync with `lots`
        realizedPnL: 0,
        lastPrice: normalized.referencePrice,
        activeReference: normalized.referencePrice,
        lastEventTimestamp: config.referenceCapturedAt ? new Date(config.referenceCapturedAt).toISOString() : null,
        sequence: 0,
    };
}

/**
 * Finds every grid level crossed moving from prevPrice to newPrice
 * (inclusive at BOTH ends), relative to `referenceCents` — the CURRENT
 * active reference at the start of this event, not necessarily the
 * immutable initial reference. Returns level offsets (integer steps from
 * that reference) in actual traversal order (closest-to-prev first),
 * which matters because cash/holdings constraints are applied
 * sequentially within one event, and because the reference itself rebases
 * to the last offset reached.
 */
function findCrossedLevels(gridInterval, referenceCents, prevPriceCents, newPriceCents) {
    if (prevPriceCents === newPriceCents) return [];

    const direction = newPriceCents > prevPriceCents ? "up" : "down";
    const intervalCents = toCents(gridInterval);

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

function applyBuy({ config, cash, holdings, lots, fillPrice, level, levelPriceValue }) {
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
            lots,
            avgCost: weightedAvgCost(lots),
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
    const newLots = [...lots, { qty, price: unitCost }]; // FIFO: new lot goes to the back of the queue
    const newHoldings = holdings + qty;
    const newCash = roundPrice(cash - cost);

    return {
        cash: newCash,
        holdings: newHoldings,
        lots: newLots,
        avgCost: weightedAvgCost(newLots),
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

function applySell({ config, cash, holdings, lots, realizedPnL, fillPrice, level, levelPriceValue }) {
    const slippageMultiplier = 1 - config.slippagePct / 100;
    const effectivePrice = roundPrice(fillPrice * slippageMultiplier);
    const unitProceeds = roundPrice(effectivePrice * (1 - config.commissionPct / 100));

    // ADR-035: SELL fills use sellQuantityPerLevel when set, else mirror
    // quantityPerLevel (the "buy quantity") — same mirror pattern as
    // sellVariance/gridInterval.
    const targetQty = config.sellQuantityPerLevel ?? config.quantityPerLevel;
    const qty = Math.max(0, Math.min(targetQty, holdings));

    if (qty < 1) {
        return {
            cash,
            holdings,
            lots,
            avgCost: weightedAvgCost(lots),
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
    // FIFO (ADR-032): consume the OLDEST lots first, each at its own
    // original purchase price — never a single blended average.
    const { lots: newLots, realizedPnLDelta } = consumeLotsFifo(lots, qty, unitProceeds);
    const newHoldings = holdings - qty;
    const newCash = roundPrice(cash + proceeds);
    const newRealizedPnL = roundPrice(realizedPnL + realizedPnLDelta);

    return {
        cash: newCash,
        holdings: newHoldings,
        lots: newLots,
        avgCost: weightedAvgCost(newLots),
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

    const activeReference = state.activeReference == null ? config.referencePrice : state.activeReference;
    const direction = roundedPrice < prevPrice ? "down" : "up";
    // ADR-034: a downward move only ever crosses BUY levels (spaced by
    // gridInterval, the "buy variance"); an upward move only ever crosses
    // SELL levels (spaced by sellVariance, or gridInterval when sellVariance
    // isn't set). Direction is fixed for the whole event, so only one
    // variance is ever relevant per call.
    const variance = direction === "down" ? config.gridInterval : (config.sellVariance ?? config.gridInterval);
    const crossedLevels = findCrossedLevels(variance, toCents(activeReference), toCents(prevPrice), toCents(roundedPrice));

    let { cash, holdings, avgCost, realizedPnL } = state;
    let lots = state.lots || [];
    let newActiveReference = activeReference;
    const trades = [];

    // Direction alone decides the action now — every crossing is evaluated
    // fresh against the (rebasing) active reference, so there is no
    // separate armed/disarmed state to track (see ADR-031).
    crossedLevels.forEach((n) => {
        const levelPriceValue = levelPriceFromReference(activeReference, variance, n);

        if (direction === "down") {
            const result = applyBuy({ config, cash, holdings, lots, fillPrice: roundedPrice, level: n, levelPriceValue });
            cash = result.cash;
            holdings = result.holdings;
            lots = result.lots;
            avgCost = result.avgCost;
            trades.push(result.trade);
        } else {
            const result = applySell({ config, cash, holdings, lots, realizedPnL, fillPrice: roundedPrice, level: n, levelPriceValue });
            cash = result.cash;
            holdings = result.holdings;
            lots = result.lots;
            avgCost = result.avgCost;
            realizedPnL = result.realizedPnL;
            trades.push(result.trade);
        }

        // Rebase to the last (farthest) level reached — whether that
        // level's trade filled, partially filled, or was fully skipped.
        newActiveReference = levelPriceValue;
    });

    const newState = {
        cash,
        holdings,
        lots,
        avgCost,
        realizedPnL,
        lastPrice: roundedPrice,
        activeReference: newActiveReference,
        lastEventTimestamp: eventTimestamp,
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
 * already used internally (including the FIFO lot queue, ADR-032, so
 * avgCostAfter reflects the real remaining lots, not a re-blended
 * average). This never re-decides anything (quantities/prices, and for a
 * SELL its realizedPnLDelta, are already final/trusted from the trade
 * itself) — it only reconstructs the audit trail the pure engine's return
 * value doesn't carry per-trade. Shared by both the live simulator
 * (gridSimulatorService.js) and the historical replay engine
 * (gridBacktestEngine.js) so the ledger's running-balance math is never
 * duplicated.
 */
function annotateRunningState(trades, startState, commissionPct) {
    let cash = startState.cash;
    let holdings = startState.holdings;
    let lots = startState.lots || [];

    return trades.map((trade) => {
        if (trade.type === "BUY" && trade.qtyFilled > 0) {
            const unitCost = roundPrice(trade.effectivePrice * (1 + commissionPct / 100));
            const cost = roundPrice(trade.qtyFilled * unitCost);
            lots = [...lots, { qty: trade.qtyFilled, price: unitCost }];
            holdings += trade.qtyFilled;
            cash = roundPrice(cash - cost);
        } else if (trade.type === "SELL" && trade.qtyFilled > 0) {
            const unitProceeds = roundPrice(trade.effectivePrice * (1 - commissionPct / 100));
            const proceeds = roundPrice(trade.qtyFilled * unitProceeds);
            lots = consumeLotsFifo(lots, trade.qtyFilled, unitProceeds).lots;
            holdings -= trade.qtyFilled;
            cash = roundPrice(cash + proceeds);
        }
        return { ...trade, cashAfter: cash, holdingsAfter: holdings, avgCostAfter: weightedAvgCost(lots) };
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
    levelPriceFromReference,
    weightedAvgCost,
    consumeLotsFifo,
    createInitialGridState,
    findCrossedLevels,
    processPriceUpdate,
    computePortfolioMetrics,
    annotateRunningState,
};
