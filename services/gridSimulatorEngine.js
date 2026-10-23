/**
 * Grid Trading Simulator — pure, deterministic crossing/accounting engine.
 *
 * PAPER TRADING ONLY. Nothing in this file (or anything that calls it)
 * places a real broker order. Every "fill" is a simulated bookkeeping
 * entry against virtual cash/holdings.
 *
 * Design (see .claude/state/DECISIONS.md ADR-021 for the original fixed-
 * grid design, ADR-031 for the trailing/rebasing redesign, ADR-037 for the
 * per-fill paired-trigger redesign which replaces ADR-031's single
 * `activeReference`, and ADR-038 below):
 *
 * - `config.referencePrice` ("Initial Reference") is the immutable anchor
 *   — kept forever for audit/display, but it does NOT define the tradeable
 *   grid levels once trading begins. ADR-038: captured at session START
 *   (not creation) from a fresh live quote, and the session's first trade
 *   is an IMMEDIATE BUY at that exact price (`startWithInitialBuy()`),
 *   establishing an initial position right away instead of waiting for a
 *   crossing. `createInitialGridState()` below is still used to build the
 *   pre-trade "shell" (seeds `pendingBuyLevels` at `referencePrice -
 *   buyVariance` — which, not coincidentally, IS this initial buy's own
 *   continuation target, so it needs no further adjustment);
 *   `startWithInitialBuy()` then applies the one real fill on top of it and
 *   arms that fill's own sell target. Session CREATION, by contrast, has no
 *   reference yet at all — `createShellState()` builds a reference-free
 *   shell (cash/holdings from config only) for display between creation
 *   and the user clicking Start.
 * - `state.pendingBuyLevels`/`state.pendingSellLevels` (ADR-037) are arrays
 *   of prices — every currently-armed trigger of that type. Every FILLED
 *   (or skipped/partially-filled) BUY at price P consumes itself and arms
 *   TWO new levels: a SELL at `P + sellVariance` (that specific buy's own
 *   take-profit target — never a shared/rebasing reference) and a BUY at
 *   `P - buyVariance` (continues the accumulation ladder if price keeps
 *   falling). Symmetrically, every SELL at price P arms a BUY at
 *   `P - buyVariance` and a SELL at `P + sellVariance`. This is the
 *   standard "replace a filled order with two new ones" grid-bot rule.
 *   `pendingBuyLevels` seeds with one entry at `referencePrice -
 *   buyVariance`; `pendingSellLevels` seeds empty (or with one entry at
 *   `startingAvgCost + sellVariance` when the session starts with existing
 *   holdings).
 * - A newly-armed SELL level is always ABOVE current price at the moment
 *   it's created (it's created exactly when a buy just happened at a lower
 *   price), and a newly-armed BUY level is always BELOW current price at
 *   creation — this is an invariant that holds for the lifetime of every
 *   level, not just at creation. So a downward price move can only ever
 *   cross pending BUY-type levels, and an upward move can only ever cross
 *   pending SELL-type levels — never a mix within one event, which keeps
 *   direction alone sufficient to decide which array to scan (same
 *   dispatch simplicity as ADR-031's "direction alone decides the
 *   action").
 * - One price update (one tick, or one open-after-gap event) can still
 *   cross several levels at once (e.g. an overnight gap) — this now
 *   requires an iterative cascade (pop the nearest in-range level, fire
 *   it, arm its two follow-on levels, check again) since there's no
 *   closed-form lattice to compute the whole crossed set from in one shot
 *   the way ADR-031's single reference allowed. The cascade is bounded:
 *   each step moves the remaining range closer by at least one
 *   buyVariance/sellVariance. Every level crossed in that single update
 *   fills at the SAME actual event price — never at its own (possibly-
 *   skipped) level price. The triggering level and the simulated fill
 *   price are always recorded separately.
 * - A buy/sell that can't be filled in full (insufficient cash/holdings)
 *   fills the affordable/available remainder (if >=1 share) or is fully
 *   skipped — either way it still consumes its own triggering level and
 *   still arms both follow-on levels, so the ladder keeps moving
 *   deterministically regardless of fill success. This is the same
 *   philosophy ADR-031 used for its single reference, applied per-level.
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
 *   the lot queue is empty (holdings back to exactly 0). ADR-037 does NOT
 *   change any of this — a SELL always consumes the oldest lot(s) first,
 *   regardless of which pending level fired it, exactly as before.
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
 * - ADR-039: zero-friction fills. There is no slippage/commission knob —
 *   every BUY/SELL fills at the exact observed event price, full stop. An
 *   earlier revision modeled a synthetic `commissionPct`/`slippagePct`
 *   two-knob cost (same shape as the professional backtest/live engines'
 *   model), but for a grid strategy with a small per-level variance, that
 *   synthetic round-trip cost could dwarf the variance itself and make
 *   every cycle a guaranteed loser regardless of price direction — a
 *   confusing, unrealistic result. Real transaction-cost estimation (STT,
 *   exchange charges, GST, SEBI fee, stamp duty, Zerodha-style brokerage)
 *   is modeled separately and accurately by `gridChargesCalculator.js`
 *   (ADR-035) and shown as a dedicated, informational-only "Charges"
 *   summary — it never adjusts the actual fill price or cash/realizedPnL,
 *   by design, so the core P&L stays simple and exactly reconcilable from
 *   the trade ledger's own fillPrice/qtyFilled columns.
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

    // ADR-040: optional price limits — a floor below which BUYs pause and a
    // ceiling above which SELLs pause (see processPriceUpdate). Both null/
    // absent by default (no limit). When either is provided it must be a
    // positive number; when both are provided, upperLimit must exceed
    // lowerLimit (an inverted or equal band can never be meaningfully
    // traded).
    if (config.lowerLimit !== undefined && config.lowerLimit !== null) {
        if (!isFiniteNumber(config.lowerLimit) || config.lowerLimit <= 0) {
            errors.push("lowerLimit must be a positive number when provided");
        }
    }
    if (config.upperLimit !== undefined && config.upperLimit !== null) {
        if (!isFiniteNumber(config.upperLimit) || config.upperLimit <= 0) {
            errors.push("upperLimit must be a positive number when provided");
        }
    }
    if (
        config.lowerLimit != null &&
        config.upperLimit != null &&
        isFiniteNumber(config.lowerLimit) &&
        isFiniteNumber(config.upperLimit) &&
        config.upperLimit <= config.lowerLimit
    ) {
        errors.push("upperLimit must be greater than lowerLimit");
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
        startingHoldings: Math.max(0, Math.trunc(config.startingHoldings || 0)),
        startingAvgCost: config.startingHoldings > 0 ? roundPrice(config.startingAvgCost) : 0,
        // ADR-040: optional price band. null/absent means no limit on that
        // side.
        lowerLimit: config.lowerLimit != null ? roundPrice(config.lowerLimit) : null,
        upperLimit: config.upperLimit != null ? roundPrice(config.upperLimit) : null,
    };
}

/** Level price relative to the IMMUTABLE initial reference — used only for
 *  display/audit, never for deciding crossings (ADR-037 crossings are
 *  decided against `state.pendingBuyLevels`/`pendingSellLevels` instead). */
function levelPrice(config, n) {
    return roundPrice(config.referencePrice + n * config.gridInterval);
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
 * implicit null-fallback. `lastPrice` is likewise seeded to the anchor
 * itself (`referencePrice`) rather than null, matching the same intent.
 *
 * ADR-037: `pendingBuyLevels` seeds with exactly one entry
 * (`referencePrice - buyVariance`) — the only trigger needed before any
 * fill has ever happened. `pendingSellLevels` seeds empty UNLESS the
 * session starts with existing holdings, in which case that starting
 * position gets its own sell target too (`startingAvgCost +
 * sellVariance`), symmetric to how a real BUY fill would arm one.
 */
function createInitialGridState(config) {
    const normalized = normalizeConfig(config);
    const lots = normalized.startingHoldings > 0 ? [{ qty: normalized.startingHoldings, price: normalized.startingAvgCost }] : [];
    const sellVariance = normalized.sellVariance ?? normalized.gridInterval;
    return {
        cash: normalized.startingCapital,
        holdings: normalized.startingHoldings,
        lots, // FIFO cost-basis queue (ADR-032) — starting inventory seeds one lot
        avgCost: normalized.startingAvgCost, // derived display value, kept in sync with `lots`
        realizedPnL: 0,
        lastPrice: normalized.referencePrice,
        pendingBuyLevels: [roundPrice(normalized.referencePrice - normalized.gridInterval)],
        pendingSellLevels: normalized.startingHoldings > 0 ? [roundPrice(normalized.startingAvgCost + sellVariance)] : [],
        lastEventTimestamp: config.referenceCapturedAt ? new Date(config.referenceCapturedAt).toISOString() : null,
        sequence: 0,
    };
}

/**
 * ADR-038: a reference-free "shell" state for a session that's been
 * created but not yet started — cash/holdings/lots are already known from
 * config (startingCapital/startingHoldings/startingAvgCost), but there is
 * no referencePrice yet (that's only captured when the user clicks Start),
 * so there are no pending trigger levels and no lastPrice either.
 */
function createShellState(config) {
    const startingHoldings = Math.max(0, Math.trunc(config.startingHoldings || 0));
    const startingAvgCost = startingHoldings > 0 ? roundPrice(config.startingAvgCost) : 0;
    const lots = startingHoldings > 0 ? [{ qty: startingHoldings, price: startingAvgCost }] : [];
    return {
        cash: roundPrice(config.startingCapital),
        holdings: startingHoldings,
        lots,
        avgCost: startingAvgCost,
        realizedPnL: 0,
        lastPrice: null,
        pendingBuyLevels: [],
        pendingSellLevels: [],
        lastEventTimestamp: null,
        sequence: 0,
    };
}

/**
 * ADR-038: the live simulator's "Start" action — `rawConfig.referencePrice`
 * must already be a freshly-captured, validated live quote (same
 * provenance guarantee ADR-023/024 required at creation; the fetch/
 * freshness check itself lives in gridSimulatorRoutes.js's
 * captureFreshReference(), which needs marketDataService that this
 * DB-only/pure-math service deliberately doesn't depend on).
 *
 * Composes two already-proven building blocks rather than duplicating
 * their logic: `createInitialGridState()` (unchanged — its seeded
 * `pendingBuyLevels` at `referencePrice - buyVariance` already IS this
 * initial buy's own continuation target, needing no further adjustment)
 * and `applyBuy()` (unchanged — the exact same slippage/commission/qty-
 * clamp/FIFO-lot logic every other buy fill uses), executed immediately
 * at the reference price itself rather than triggered by a crossing. Only
 * the resulting fill's own SELL target needs arming on top of whatever
 * `createInitialGridState()` already seeded.
 */
function startWithInitialBuy(rawConfig, referenceCapturedAt) {
    const config = normalizeConfig(rawConfig);
    const seeded = createInitialGridState(rawConfig);
    const buyResult = applyBuy({
        config,
        cash: seeded.cash,
        holdings: seeded.holdings,
        lots: seeded.lots,
        fillPrice: config.referencePrice,
        level: 0, // marks the one-time initial buy — distinct from the signed per-event counters used elsewhere
        levelPriceValue: config.referencePrice,
    });

    const sellVariance = config.sellVariance ?? config.gridInterval;
    const pendingSellLevels = addPendingLevel([...seeded.pendingSellLevels], roundPrice(config.referencePrice + sellVariance));

    return {
        state: {
            cash: buyResult.cash,
            holdings: buyResult.holdings,
            lots: buyResult.lots,
            avgCost: buyResult.avgCost,
            realizedPnL: 0,
            lastPrice: config.referencePrice,
            pendingBuyLevels: seeded.pendingBuyLevels,
            pendingSellLevels,
            lastEventTimestamp: new Date(referenceCapturedAt).toISOString(),
            sequence: 1,
        },
        trade: buyResult.trade,
    };
}

/**
 * Adds `priceValue` to `levels` unless a level at that exact price (to
 * paise precision) already exists — a harmless de-dup against the rare
 * case of two independent fills arming the same exact trigger price.
 * Mutates and returns `levels` for convenient chaining.
 */
function addPendingLevel(levels, priceValue) {
    const cents = toCents(priceValue);
    if (!levels.some((p) => toCents(p) === cents)) levels.push(roundPrice(priceValue));
    return levels;
}

/**
 * ADR-037: repeatedly pops the nearest pending level of the active
 * direction that still falls within `[loCents, hiCents]`, in traversal
 * order (closest-to-prev first — same discipline ADR-031's single-
 * reference lattice used). Returns the ordered list of fired level prices;
 * the caller (processPriceUpdate) is responsible for actually applying
 * each fill and arming its two follow-on levels before the next iteration
 * can see them — this function only discovers WHICH existing levels are in
 * range at the moment it's called, it does not arm new ones itself (it has
 * no visibility into fills/follow-ons, which depend on cash/holdings state
 * this pure discovery step doesn't touch).
 */
function findNearestInRangeLevel(levels, loCents, hiCents, direction) {
    const inRange = levels.filter((p) => {
        const c = toCents(p);
        return c >= loCents && c <= hiCents;
    });
    if (inRange.length === 0) return null;
    // "Nearest to prevPrice" means: largest remaining value on a down move
    // (prevPrice is at the top of the range), smallest on an up move
    // (prevPrice is at the bottom of the range).
    return roundPrice(direction === "down" ? Math.max(...inRange) : Math.min(...inRange));
}

function applyBuy({ config, cash, holdings, lots, fillPrice, level, levelPriceValue }) {
    const unitCost = roundPrice(fillPrice);

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
            qtyRequested: targetQty,
            qtyFilled: qty,
            qtySkipped: targetQty - qty,
            reason: qty < targetQty ? "insufficient_cash_partial" : null,
            realizedPnLDelta: 0,
        },
    };
}

function applySell({ config, cash, holdings, lots, realizedPnL, fillPrice, level, levelPriceValue }) {
    const unitProceeds = roundPrice(fillPrice);

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
    const buyVariance = config.gridInterval;
    const sellVariance = config.sellVariance ?? config.gridInterval;
    const loCents = Math.min(toCents(prevPrice), toCents(roundedPrice));
    const hiCents = Math.max(toCents(prevPrice), toCents(roundedPrice));

    let { cash, holdings, avgCost, realizedPnL } = state;
    let lots = state.lots || [];
    let pendingBuyLevels = [...(state.pendingBuyLevels || [])];
    let pendingSellLevels = [...(state.pendingSellLevels || [])];
    const trades = [];

    // ADR-040: optional price band — BUYs pause once the current price is
    // at/below lowerLimit (every fill in this event would execute at
    // roundedPrice, so if that price already breaches the floor, no buy
    // this event can avoid breaching it either), SELLs pause once price is
    // at/above upperLimit. This is a live gate, not a one-time trip: armed
    // levels are untouched (never consumed/removed) while paused, and the
    // very next event where price is back within bounds cascades through
    // them normally.
    const buysLimited = direction === "down" && config.lowerLimit != null && roundedPrice <= config.lowerLimit;
    const sellsLimited = direction === "up" && config.upperLimit != null && roundedPrice >= config.upperLimit;

    // ADR-037: direction alone decides which array is even reachable this
    // event (see the file doc comment's invariant — a newly-armed SELL
    // level is always above current price at creation, a newly-armed BUY
    // level always below, so a downward move can never reach a pending
    // SELL and vice versa). Iterative because there's no closed-form
    // lattice anymore: firing a level arms a new same-direction level that
    // may ALSO fall within the remaining range — a gap must still cascade
    // through every level it passes, exactly as ADR-031 did.
    for (;;) {
        if (buysLimited || sellsLimited) break;
        const levelPriceValue = findNearestInRangeLevel(direction === "down" ? pendingBuyLevels : pendingSellLevels, loCents, hiCents, direction);
        if (levelPriceValue == null) break;

        if (direction === "down") {
            pendingBuyLevels = pendingBuyLevels.filter((p) => toCents(p) !== toCents(levelPriceValue));
            const result = applyBuy({ config, cash, holdings, lots, fillPrice: roundedPrice, level: -(trades.length + 1), levelPriceValue });
            cash = result.cash;
            holdings = result.holdings;
            lots = result.lots;
            avgCost = result.avgCost;
            trades.push(result.trade);

            addPendingLevel(pendingSellLevels, levelPriceValue + sellVariance);
            addPendingLevel(pendingBuyLevels, levelPriceValue - buyVariance);
        } else {
            pendingSellLevels = pendingSellLevels.filter((p) => toCents(p) !== toCents(levelPriceValue));
            const result = applySell({ config, cash, holdings, lots, realizedPnL, fillPrice: roundedPrice, level: trades.length + 1, levelPriceValue });
            cash = result.cash;
            holdings = result.holdings;
            lots = result.lots;
            avgCost = result.avgCost;
            realizedPnL = result.realizedPnL;
            trades.push(result.trade);

            addPendingLevel(pendingBuyLevels, levelPriceValue - buyVariance);
            addPendingLevel(pendingSellLevels, levelPriceValue + sellVariance);
        }
    }

    const newState = {
        cash,
        holdings,
        lots,
        avgCost,
        realizedPnL,
        lastPrice: roundedPrice,
        pendingBuyLevels,
        pendingSellLevels,
        lastEventTimestamp: eventTimestamp,
        sequence: state.sequence + 1,
    };

    return { state: newState, trades, skipped: false, gapFill: trades.length > 1 };
}

/**
 * Replays a batch of the engine's already-decided trades (in their
 * original order) over the pre-update state to recover each trade's own
 * running cash/holdings/avgCost snapshot for the ledger — using only each
 * trade's own recorded fields (qtyFilled/fillPrice/type), the exact same
 * arithmetic applyBuy/applySell already used internally (including the
 * FIFO lot queue, ADR-032, so avgCostAfter reflects the real remaining
 * lots, not a re-blended average). This never re-decides anything
 * (quantities/prices, and for a SELL its realizedPnLDelta, are already
 * final/trusted from the trade itself) — it only reconstructs the audit
 * trail the pure engine's return value doesn't carry per-trade. Shared by
 * both the live simulator (gridSimulatorService.js) and the historical
 * replay engine (gridBacktestEngine.js) so the ledger's running-balance
 * math is never duplicated.
 */
function annotateRunningState(trades, startState) {
    let cash = startState.cash;
    let holdings = startState.holdings;
    let lots = startState.lots || [];

    return trades.map((trade) => {
        if (trade.type === "BUY" && trade.qtyFilled > 0) {
            const unitCost = roundPrice(trade.fillPrice);
            const cost = roundPrice(trade.qtyFilled * unitCost);
            lots = [...lots, { qty: trade.qtyFilled, price: unitCost }];
            holdings += trade.qtyFilled;
            cash = roundPrice(cash - cost);
        } else if (trade.type === "SELL" && trade.qtyFilled > 0) {
            const unitProceeds = roundPrice(trade.fillPrice);
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
    weightedAvgCost,
    consumeLotsFifo,
    createInitialGridState,
    createShellState,
    startWithInitialBuy,
    addPendingLevel,
    findNearestInRangeLevel,
    processPriceUpdate,
    computePortfolioMetrics,
    annotateRunningState,
};
