/**
 * Grid Trading Simulator — pure engine tests (paper trading only).
 * Plain Node `assert`, same tiny custom harness convention as the rest of
 * this backend's test suite. No DB, no network — services/gridSimulatorEngine.js
 * is a pure function module.
 */
const assert = require("assert");
const {
    validateGridConfig,
    createInitialGridState,
    addPendingLevel,
    findNearestInRangeLevel,
    processPriceUpdate,
    computePortfolioMetrics,
    toCents,
    levelPrice,
    roundPrice,
    weightedAvgCost,
    consumeLotsFifo,
} = require("../services/gridSimulatorEngine");

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        passed += 1;
        console.log(`  ✓ ${name}`);
    } catch (error) {
        failed += 1;
        console.error(`  ✗ ${name}`);
        console.error(`    ${error.stack || error.message}`);
    }
}

const BASE_CONFIG = {
    referencePrice: 340,
    gridInterval: 3,
    quantityPerLevel: 100,
    startingCapital: 100000,
    maxPositionSize: null,
    commissionPct: 0,
    slippagePct: 0,
};

function tick(n) {
    return new Date(2026, 0, 1, 9, 15, n).toISOString();
}

// --- validateGridConfig ---

test("validateGridConfig accepts a valid config", () => {
    const result = validateGridConfig(BASE_CONFIG);
    assert.strictEqual(result.valid, true);
    assert.deepStrictEqual(result.errors, []);
});

test("validateGridConfig rejects non-positive referencePrice/gridInterval", () => {
    assert.strictEqual(validateGridConfig({ ...BASE_CONFIG, referencePrice: 0 }).valid, false);
    assert.strictEqual(validateGridConfig({ ...BASE_CONFIG, gridInterval: -1 }).valid, false);
});

test("validateGridConfig rejects non-integer/zero quantityPerLevel", () => {
    assert.strictEqual(validateGridConfig({ ...BASE_CONFIG, quantityPerLevel: 1.5 }).valid, false);
    assert.strictEqual(validateGridConfig({ ...BASE_CONFIG, quantityPerLevel: 0 }).valid, false);
});

test("validateGridConfig rejects a gridInterval smaller than one paisa", () => {
    const result = validateGridConfig({ ...BASE_CONFIG, gridInterval: 0.001 });
    assert.strictEqual(result.valid, false);
});

// --- level math ---

test("levelPrice computes downward and upward levels around the reference", () => {
    assert.strictEqual(levelPrice(BASE_CONFIG, -1), 337);
    assert.strictEqual(levelPrice(BASE_CONFIG, -2), 334);
    assert.strictEqual(levelPrice(BASE_CONFIG, 1), 343);
    assert.strictEqual(levelPrice(BASE_CONFIG, 2), 346);
});

test("addPendingLevel appends a new price, but de-dupes an exact-price collision", () => {
    const levels = [100, 103];
    addPendingLevel(levels, 106);
    assert.deepStrictEqual(levels, [100, 103, 106]);
    addPendingLevel(levels, 103); // exact collision — not re-added
    assert.deepStrictEqual(levels, [100, 103, 106]);
});

test("findNearestInRangeLevel picks the nearest-to-prevPrice level within range, per direction", () => {
    // Moving down from 340 to 330: nearest-to-prev (340) in-range level is
    // the LARGEST one in range.
    assert.strictEqual(findNearestInRangeLevel([337, 334, 331, 320], toCents(330), toCents(340), "down"), 337);
    // Moving up from 340 to 350: nearest-to-prev (340) in-range level is the
    // SMALLEST one in range.
    assert.strictEqual(findNearestInRangeLevel([343, 346, 349, 360], toCents(340), toCents(350), "up"), 343);
});

test("findNearestInRangeLevel returns null when nothing is in range", () => {
    assert.strictEqual(findNearestInRangeLevel([300, 500], toCents(330), toCents(340), "down"), null);
    assert.strictEqual(findNearestInRangeLevel([], toCents(330), toCents(340), "down"), null);
});

test("findNearestInRangeLevel includes the exact boundary (inclusive both ends)", () => {
    assert.strictEqual(findNearestInRangeLevel([334], toCents(334), toCents(337), "up"), 334);
    assert.strictEqual(findNearestInRangeLevel([337], toCents(334), toCents(337), "down"), 337);
});

// --- single downward crossing triggers a buy at the ACTUAL price ---

test("a single downward crossing buys at the actual tick price, not the grid price", () => {
    const state = createInitialGridState(BASE_CONFIG);
    const result = processPriceUpdate({ config: BASE_CONFIG, state, price: 336, eventTimestamp: tick(1) });

    assert.strictEqual(result.trades.length, 1);
    const [trade] = result.trades;
    assert.strictEqual(trade.type, "BUY");
    assert.strictEqual(trade.level, -1);
    assert.strictEqual(trade.levelPrice, 337); // triggering grid level
    assert.strictEqual(trade.fillPrice, 336); // simulated fill price (actual event price)
    assert.strictEqual(trade.qtyFilled, 100);
    assert.strictEqual(trade.qtySkipped, 0);

    assert.strictEqual(result.state.holdings, 100);
    assert.strictEqual(result.state.avgCost, 336);
    assert.strictEqual(result.state.cash, 100000 - 100 * 336);
});

test("a single upward move sells at the actual tick price, cascading through the sell level the BUY armed plus its own follow-on (ADR-037)", () => {
    let state = createInitialGridState(BASE_CONFIG);
    state = processPriceUpdate({ config: BASE_CONFIG, state, price: 336, eventTimestamp: tick(1) }).state; // BUY 100 @336 arms SELL@340, BUY@334

    // Price rises to 345: crosses the armed SELL@340 (fills all 100 held),
    // which arms a follow-on SELL@343 — which is ALSO within [336,345], so
    // the cascade fires it too (fully skipped, nothing left to sell).
    const result = processPriceUpdate({ config: BASE_CONFIG, state, price: 345, eventTimestamp: tick(2) });
    assert.strictEqual(result.trades.length, 2);

    const [first, second] = result.trades;
    assert.strictEqual(first.type, "SELL");
    assert.strictEqual(first.levelPrice, 340);
    assert.strictEqual(first.fillPrice, 345);
    assert.strictEqual(first.qtyFilled, 100); // all 100 held shares sold here

    assert.strictEqual(second.type, "SELL");
    assert.strictEqual(second.levelPrice, 343);
    assert.strictEqual(second.qtyFilled, 0);
    assert.strictEqual(second.reason, "insufficient_holdings"); // nothing left to sell

    assert.strictEqual(result.state.holdings, 0);
    assert.strictEqual(result.state.avgCost, 0); // reset when flat
    assert.strictEqual(result.state.realizedPnL, 100 * (345 - 336));
    assert.deepStrictEqual(result.state.pendingBuyLevels, [334, 337, 340]); // original continuation + each sell's own buy-back target
    assert.deepStrictEqual(result.state.pendingSellLevels, [346]); // 343's own follow-on
});

// --- ADR-031: trailing/rebasing active reference ---

test("a fluctuation that does not cross any pending level produces no trade", () => {
    let state = createInitialGridState(BASE_CONFIG);
    state = processPriceUpdate({ config: BASE_CONFIG, state, price: 336, eventTimestamp: tick(1) }).state; // BUY @336 arms SELL@340, BUY@334

    // Price wiggles within the same band (334 < price < 340).
    state = processPriceUpdate({ config: BASE_CONFIG, state, price: 335.5, eventTimestamp: tick(2) }).state;
    const noRetrigger = processPriceUpdate({ config: BASE_CONFIG, state, price: 336.2, eventTimestamp: tick(3) });
    assert.strictEqual(noRetrigger.trades.length, 0);
    assert.strictEqual(noRetrigger.state.holdings, 100); // unchanged
    assert.deepStrictEqual(noRetrigger.state.pendingBuyLevels, [334]); // unchanged — no level crossed
    assert.deepStrictEqual(noRetrigger.state.pendingSellLevels, [340]);
});

test("ADR-037: with zero starting holdings, an upward move before any BUY has ever happened finds no pending sell level to cross (nothing to sell since nothing was ever bought) — zero trades", () => {
    const config = { ...BASE_CONFIG, referencePrice: 320, startingCapital: 100000 };
    const state = createInitialGridState(config); // holdings = 0, pendingSellLevels seeds empty
    assert.deepStrictEqual(state.pendingSellLevels, []);

    const up = processPriceUpdate({ config, state, price: 329, eventTimestamp: tick(1) });
    assert.strictEqual(up.trades.length, 0); // no pending sell level exists to even attempt
    assert.strictEqual(up.state.holdings, 0);
    assert.deepStrictEqual(up.state.pendingBuyLevels, [317]); // the original seed is untouched

    // The ladder still works normally for its actual job: a pullback to the
    // original seeded BUY level still buys.
    const pullback = processPriceUpdate({ config, state: up.state, price: 317, eventTimestamp: tick(2) });
    assert.strictEqual(pullback.trades.length, 1);
    assert.strictEqual(pullback.trades[0].type, "BUY");
    assert.strictEqual(pullback.trades[0].qtyFilled, 100);
});

test("ADR-037: a skipped (insufficient-cash) BUY still arms both follow-on levels, so a later bounce can sell at the level it armed", () => {
    const config = { ...BASE_CONFIG, referencePrice: 320, startingCapital: 0 }; // zero cash -> every buy skips
    let state = createInitialGridState(config);

    const down = processPriceUpdate({ config, state, price: 311, eventTimestamp: tick(1) }); // crosses 317, 314, 311
    assert.strictEqual(down.trades.length, 3);
    down.trades.forEach((trade) => {
        assert.strictEqual(trade.type, "BUY");
        assert.strictEqual(trade.qtyFilled, 0);
        assert.strictEqual(trade.reason, "insufficient_cash");
    });
    assert.deepStrictEqual(down.state.pendingBuyLevels, [308]); // continuation ladder kept going
    assert.deepStrictEqual(down.state.pendingSellLevels, [320, 317, 314]); // each skipped buy still armed its own sell target
    state = { ...down.state, holdings: 100, avgCost: 311, cash: 0 }; // simulate already owning shares for the sell leg

    const bounce = processPriceUpdate({ config, state, price: 314, eventTimestamp: tick(2) });
    assert.strictEqual(bounce.trades.length, 1);
    assert.strictEqual(bounce.trades[0].type, "SELL"); // 314 was armed by the skipped buy at that level
    assert.strictEqual(bounce.trades[0].levelPrice, 314);
    assert.strictEqual(bounce.trades[0].qtyFilled, 100);
});

test("ADR-037 primary regression: the exact worked example (ref 50, buyVariance 2, sellVariance 3) — sells fire at 49 then 51, NOT 52", () => {
    const config = { referencePrice: 50, gridInterval: 2, sellVariance: 3, quantityPerLevel: 10, startingCapital: 1000000, commissionPct: 0, slippagePct: 0 };
    let state = createInitialGridState(config);
    let t = Date.parse("2026-01-01T09:00:00.000Z");
    const nextTick = () => new Date((t += 1000)).toISOString();

    let r = processPriceUpdate({ config, state, price: 48, eventTimestamp: nextTick() }); // BUY @48
    assert.strictEqual(r.trades[0].type, "BUY");
    assert.strictEqual(r.trades[0].levelPrice, 48);
    state = r.state;
    assert.deepStrictEqual(state.pendingSellLevels, [51]); // 48's own sell target

    r = processPriceUpdate({ config, state, price: 46, eventTimestamp: nextTick() }); // BUY @46
    assert.strictEqual(r.trades[0].type, "BUY");
    assert.strictEqual(r.trades[0].levelPrice, 46);
    state = r.state;
    assert.deepStrictEqual(state.pendingSellLevels, [51, 49]); // 46's own sell target, independent of 48's

    r = processPriceUpdate({ config, state, price: 49, eventTimestamp: nextTick() }); // SELL @49 — the 46-lot's own target
    assert.strictEqual(r.trades.length, 1);
    assert.strictEqual(r.trades[0].type, "SELL");
    assert.strictEqual(r.trades[0].levelPrice, 49);
    state = r.state;

    r = processPriceUpdate({ config, state, price: 51, eventTimestamp: nextTick() }); // SELL @51 — the 48-lot's own target, NOT 52
    assert.strictEqual(r.trades.length, 1);
    assert.strictEqual(r.trades[0].type, "SELL");
    assert.strictEqual(r.trades[0].levelPrice, 51);
});

test("ADR-037 fully symmetric: 2 sells before any buy each arm their own independent pending BUY level", () => {
    const config = { referencePrice: 40, gridInterval: 2, sellVariance: 3, quantityPerLevel: 10, startingCapital: 1000000, startingHoldings: 20, startingAvgCost: 40, commissionPct: 0, slippagePct: 0 };
    let state = createInitialGridState(config);
    assert.deepStrictEqual(state.pendingSellLevels, [43]); // seeded from starting inventory (40 + 3)
    assert.deepStrictEqual(state.pendingBuyLevels, [38]); // original seed (40 - 2)
    let t = Date.parse("2026-01-01T09:00:00.000Z");
    const nextTick = () => new Date((t += 1000)).toISOString();

    let r = processPriceUpdate({ config, state, price: 43, eventTimestamp: nextTick() }); // SELL @43 arms BUY@41, SELL@46
    state = r.state;
    assert.deepStrictEqual(state.pendingBuyLevels, [38, 41]); // [original seed, this sell's buy-back target]

    r = processPriceUpdate({ config, state, price: 46, eventTimestamp: nextTick() }); // SELL @46 arms BUY@44, SELL@49
    state = r.state;
    assert.deepStrictEqual(state.pendingBuyLevels, [38, 41, 44]); // 2 independent sell-armed buy targets, not one shared/overwritten anchor

    // Price falls: the NEARER buy-back target (44) fires first, not the
    // original seed (38) or the other buy-back target (41).
    r = processPriceUpdate({ config, state, price: 44, eventTimestamp: nextTick() });
    assert.strictEqual(r.trades.length, 1);
    assert.strictEqual(r.trades[0].type, "BUY");
    assert.strictEqual(r.trades[0].levelPrice, 44);
});

test("ADR-037 gap cascade: a single large downward move still fires every pending level it passes, same as before this redesign", () => {
    const config = { ...BASE_CONFIG, startingCapital: 1000000 };
    const state = createInitialGridState(config); // pendingBuyLevels = [337]
    const result = processPriceUpdate({ config, state, price: 328, eventTimestamp: tick(1) }); // passes 337, 334, 331, 328

    assert.strictEqual(result.trades.length, 4);
    assert.deepStrictEqual(result.trades.map((t) => t.levelPrice), [337, 334, 331, 328]);
    result.trades.forEach((t) => {
        assert.strictEqual(t.type, "BUY");
        assert.strictEqual(t.fillPrice, 328); // every fill at the actual event price
        assert.strictEqual(t.qtyFilled, 100);
    });
    assert.strictEqual(result.state.holdings, 400);
    assert.deepStrictEqual(result.state.pendingBuyLevels, [325]);
    assert.deepStrictEqual(result.state.pendingSellLevels, [340, 337, 334, 331]); // each fired level's own sell target
    assert.strictEqual(result.gapFill, true);
});

// --- overnight / multi-level gaps ---

test("an overnight downward gap fills every crossed level at the actual opening price", () => {
    const config = { ...BASE_CONFIG, startingCapital: 1000000 };
    const state = createInitialGridState(config);
    // Session opens directly at 310 — first-ever event, baseline is referencePrice (340).
    const result = processPriceUpdate({ config, state, price: 310, eventTimestamp: tick(1) });

    assert.strictEqual(result.trades.length, 10); // 337..310
    result.trades.forEach((trade, i) => {
        assert.strictEqual(trade.type, "BUY");
        assert.strictEqual(trade.level, -(i + 1));
        assert.strictEqual(trade.levelPrice, 337 - i * 3); // the triggering grid level
        assert.strictEqual(trade.fillPrice, 310); // ALL fill at the actual opening price
        assert.strictEqual(trade.qtyFilled, 100);
    });
    assert.strictEqual(result.state.holdings, 1000);
    assert.strictEqual(result.state.avgCost, 310);
    assert.strictEqual(result.state.cash, 1000000 - 1000 * 310);
    assert.strictEqual(result.gapFill, true);
});

test("an overnight upward gap fills every crossed sell level but never sells more than held", () => {
    const config = { ...BASE_CONFIG, startingCapital: 1000000 };
    let state = createInitialGridState(config);
    state = processPriceUpdate({ config, state, price: 310, eventTimestamp: tick(1) }).state; // holdings=1000 @310

    // Gap up through 313,316,...,352 and beyond reference — only SELL levels
    // (n>0) trigger; BUY levels crossed upward just re-arm.
    const result = processPriceUpdate({ config, state, price: 400, eventTimestamp: tick(2) });
    const sells = result.trades.filter((t) => t.type === "SELL");
    const totalSold = sells.reduce((sum, t) => sum + t.qtyFilled, 0);
    assert.ok(totalSold <= 1000, "never sells more than held");
    sells.forEach((t) => assert.strictEqual(t.fillPrice, 400));
});

// --- insufficient virtual cash ---

test("insufficient cash: partial fill when some but not a full 100 shares are affordable", () => {
    const config = { ...BASE_CONFIG, startingCapital: 1000000 };
    let state = createInitialGridState(config);
    // First gap-fill at 310 depletes cash down to a known remainder for the next test step.
    const gap = processPriceUpdate({ config, state, price: 310, eventTimestamp: tick(1) });
    state = gap.state;

    // Starting fresh with a tight budget for a single-level crossing test instead:
    const tightConfig = { ...BASE_CONFIG, startingCapital: 19090 };
    let tightState = createInitialGridState(tightConfig);
    const result = processPriceUpdate({ config: tightConfig, state: tightState, price: 337, eventTimestamp: tick(1) });
    // affordable = floor(19090/337) = 56
    assert.strictEqual(result.trades[0].qtyFilled, 56);
    assert.strictEqual(result.trades[0].qtySkipped, 44);
    assert.strictEqual(result.trades[0].reason, "insufficient_cash_partial");
    assert.strictEqual(result.state.cash, 19090 - 56 * 337);
});

test("insufficient cash: full skip when not even one share is affordable, and it still arms its follow-on levels without duplicating", () => {
    const config = { ...BASE_CONFIG, startingCapital: 100 };
    let state = createInitialGridState(config);
    const first = processPriceUpdate({ config, state, price: 337, eventTimestamp: tick(1) });
    assert.strictEqual(first.trades[0].qtyFilled, 0);
    assert.strictEqual(first.trades[0].qtySkipped, 100);
    assert.strictEqual(first.trades[0].reason, "insufficient_cash");
    assert.deepStrictEqual(first.state.pendingBuyLevels, [334]);

    // Price stays within the same band — no new level crossed, so no
    // duplicate skip-log.
    const second = processPriceUpdate({ config, state: first.state, price: 336, eventTimestamp: tick(2) });
    assert.strictEqual(second.trades.length, 0);
});

test("after a cash-skipped BUY arms its continuation level, continuing further in the same direction fires a fresh BUY attempt at the next level", () => {
    const config = { ...BASE_CONFIG, startingCapital: 100 };
    let state = createInitialGridState(config);
    state = processPriceUpdate({ config, state, price: 337, eventTimestamp: tick(1) }).state; // skipped @337, arms BUY@334
    assert.deepStrictEqual(state.pendingBuyLevels, [334]);

    const result = processPriceUpdate({ config, state, price: 334, eventTimestamp: tick(2) }); // the armed continuation level
    assert.strictEqual(result.trades.length, 1);
    assert.strictEqual(result.trades[0].type, "BUY");
    assert.strictEqual(result.trades[0].levelPrice, 334);
    assert.strictEqual(result.trades[0].reason, "insufficient_cash");
    assert.deepStrictEqual(result.state.pendingBuyLevels, [331]);
});

// --- insufficient virtual holdings ---

test("insufficient holdings: partial sell fills only what is held, never goes negative", () => {
    const config = { ...BASE_CONFIG };
    let state = createInitialGridState(config);
    state = { ...state, holdings: 50, lots: [{ qty: 50, price: 300 }], avgCost: 300, cash: 50000, pendingSellLevels: [343] };
    const result = processPriceUpdate({ config, state, price: 345, eventTimestamp: tick(1) }); // crosses the armed 343 level
    assert.strictEqual(result.trades[0].type, "SELL");
    assert.strictEqual(result.trades[0].qtyFilled, 50);
    assert.strictEqual(result.trades[0].qtySkipped, 50);
    assert.strictEqual(result.trades[0].reason, "insufficient_holdings_partial");
    assert.strictEqual(result.state.holdings, 0);
    assert.ok(result.state.holdings >= 0);
});

test("insufficient holdings: zero holdings produces a full skip, not a negative position", () => {
    const state = { ...createInitialGridState(BASE_CONFIG), pendingSellLevels: [343] };
    const result = processPriceUpdate({ config: BASE_CONFIG, state, price: 345, eventTimestamp: tick(1) });
    assert.strictEqual(result.trades[0].qtyFilled, 0);
    assert.strictEqual(result.trades[0].reason, "insufficient_holdings");
    assert.strictEqual(result.state.holdings, 0);
});

// --- maxPositionSize ---

test("maxPositionSize caps total accumulated holdings even when cash would allow more", () => {
    const config = { ...BASE_CONFIG, startingCapital: 1000000, maxPositionSize: 150 };
    let state = createInitialGridState(config);
    state = processPriceUpdate({ config, state, price: 336, eventTimestamp: tick(1) }).state; // +100 -> 100
    const result = processPriceUpdate({ config, state, price: 330, eventTimestamp: tick(2) }); // would cross 334,331 -> wants +200 more
    const totalFilled = result.trades.reduce((sum, t) => sum + t.qtyFilled, 0);
    assert.strictEqual(result.state.holdings, 150);
    assert.ok(totalFilled <= 50);
});

// --- duplicate / out-of-order updates ---

test("an exact duplicate price event produces no trades", () => {
    let state = createInitialGridState(BASE_CONFIG);
    state = processPriceUpdate({ config: BASE_CONFIG, state, price: 336, eventTimestamp: tick(1) }).state;
    const dup = processPriceUpdate({ config: BASE_CONFIG, state, price: 336, eventTimestamp: tick(2) });
    assert.strictEqual(dup.trades.length, 0);
});

test("an out-of-order (stale-timestamp) update is rejected and produces no trades", () => {
    let state = createInitialGridState(BASE_CONFIG);
    state = processPriceUpdate({ config: BASE_CONFIG, state, price: 336, eventTimestamp: tick(5) }).state;
    const stale = processPriceUpdate({ config: BASE_CONFIG, state, price: 300, eventTimestamp: tick(2) });
    assert.strictEqual(stale.skipped, true);
    assert.strictEqual(stale.reason, "duplicate_or_out_of_order_event");
    assert.strictEqual(stale.trades.length, 0);
    assert.strictEqual(stale.state.holdings, state.holdings); // unchanged
});

test("an identical-timestamp repeat of the same event is rejected as a duplicate", () => {
    let state = createInitialGridState(BASE_CONFIG);
    state = processPriceUpdate({ config: BASE_CONFIG, state, price: 336, eventTimestamp: tick(1) }).state;
    const repeat = processPriceUpdate({ config: BASE_CONFIG, state, price: 320, eventTimestamp: tick(1) });
    assert.strictEqual(repeat.skipped, true);
});

test("an invalid price (non-finite or non-positive) is rejected, never fabricated", () => {
    const state = createInitialGridState(BASE_CONFIG);
    assert.strictEqual(processPriceUpdate({ config: BASE_CONFIG, state, price: NaN, eventTimestamp: tick(1) }).skipped, true);
    assert.strictEqual(processPriceUpdate({ config: BASE_CONFIG, state, price: -5, eventTimestamp: tick(1) }).skipped, true);
    assert.strictEqual(processPriceUpdate({ config: BASE_CONFIG, state, price: 0, eventTimestamp: tick(1) }).skipped, true);
});

// --- portfolio metrics ---

test("computePortfolioMetrics reports equity/unrealized P&L consistently", () => {
    const state = { cash: 50000, holdings: 100, avgCost: 300, realizedPnL: 500 };
    const metrics = computePortfolioMetrics(state, 320);
    assert.strictEqual(metrics.marketValue, 32000);
    assert.strictEqual(metrics.equity, 82000);
    assert.strictEqual(metrics.unrealizedPnL, 100 * (320 - 300));
});

test("computePortfolioMetrics never fabricates equity when there is no current price", () => {
    const state = { cash: 50000, holdings: 100, avgCost: 300, realizedPnL: 0 };
    const metrics = computePortfolioMetrics(state, null);
    assert.strictEqual(metrics.equity, null);
    assert.strictEqual(metrics.marketValue, null);
});

test("computePortfolioMetrics reports zero unrealized P&L when holdings are zero", () => {
    const state = { cash: 100000, holdings: 0, avgCost: 0, realizedPnL: 0 };
    const metrics = computePortfolioMetrics(state, 23077.1);
    assert.strictEqual(metrics.unrealizedPnL, 0);
    assert.strictEqual(metrics.equity, 100000);
});

// Independently hand-calculated against the exact numbers reported against a
// (non-production, synthetic) session: cash ₹83,81,115.60, holdings 70,
// avgCost ₹23,079.39, last price ₹23,077.10. The reported dashboard showed
// equity ₹99,97,744.50 and unrealized P&L -₹2,255.40 — both wrong versus
// computePortfolioMetrics itself (confirming the bug was NOT in this pure
// function, but in gridSimulatorRealtime.js's Socket.IO push omitting these
// fields and the frontend merge keeping a stale prior snapshot — see
// buildUpdatePayload's fix and its own test in gridSimulatorRealtime.test.js).
test("computePortfolioMetrics reconciles the reported equity/unrealizedPnL discrepancy by hand", () => {
    const state = { cash: 8381115.6, holdings: 70, avgCost: 23079.39, realizedPnL: -3327 };
    const metrics = computePortfolioMetrics(state, 23077.1);
    assert.strictEqual(metrics.marketValue, 1615397); // 70 * 23077.10
    assert.strictEqual(metrics.equity, 9996512.6); // 8381115.60 + 1615397.00
    assert.strictEqual(roundPrice(metrics.unrealizedPnL), -160.3); // 70 * (23077.10 - 23079.39)
});

// --- Required numerical fixture: a profitable BUY-then-SELL cycle ---
//
// NOTE on the exact prices: the task's own worked example (BUY @100, SELL
// @103, gridInterval 3) is mathematically impossible to reach as two
// genuine grid-level crossings in THIS engine — sell levels sit strictly
// above the reference and buy levels strictly below it, so two valid
// (non-reference, index != 0) levels exactly G=3 apart are always adjacent
// indices n and n+1; for n<0<n+1 the only such pair is n=-1 and n+1=0,
// and index 0 is the reference itself (excluded, never a tradeable level —
// see findCrossedLevels's own doc comment and the `if (n === 0) continue`
// guard). The fill price is always the genuine OBSERVED tick price (not
// the theoretical level), so this fixture reproduces the identical
// 100 -> 103 buy/sell PRICE MOVEMENT and the exact same formula pattern
// (profit = qty * (sellPrice - buyPrice)) by crossing buy level 97 and
// sell level 103 instead of 100/103 — the accounting identities below are
// what the task's fixture is actually testing, not the specific numerals.
test("fixture: a profitable BUY-then-SELL cycle reconciles cash/holdings/realizedPnL/equity exactly", () => {
    const config = {
        referencePrice: 100,
        gridInterval: 3,
        quantityPerLevel: 10,
        startingCapital: 100000,
    };
    let state = createInitialGridState(config);

    // Down-cross through buy level 97.
    let result = processPriceUpdate({ config, state, price: 97, eventTimestamp: "2026-01-01T09:16:00.000Z" });
    state = result.state;
    assert.strictEqual(result.trades.length, 1);
    assert.strictEqual(result.trades[0].type, "BUY");
    assert.strictEqual(result.trades[0].fillPrice, 97);

    // Up-cross from the rebased reference (97) through 100 and 103 (ADR-031:
    // 100 is no longer excluded just because it equals the immutable
    // initial reference — only the CURRENT active reference's own n=0
    // point is excluded). All 10 held shares sell at the first level (100);
    // the second (103) has nothing left to sell.
    result = processPriceUpdate({ config, state, price: 103, eventTimestamp: "2026-01-01T09:17:00.000Z" });
    state = result.state;
    assert.strictEqual(result.trades.length, 2);
    assert.strictEqual(result.trades[0].type, "SELL");
    assert.strictEqual(result.trades[0].fillPrice, 103);
    assert.strictEqual(result.trades[0].qtyFilled, 10);
    assert.strictEqual(result.trades[1].qtyFilled, 0);
    assert.strictEqual(result.trades[1].reason, "insufficient_holdings");

    assert.strictEqual(state.cash, 100060); // 100000 - (10*97) + (10*103)
    assert.strictEqual(state.holdings, 0);
    assert.strictEqual(state.realizedPnL, 60); // 10 * (103 - 97)

    const metrics = computePortfolioMetrics(state, 103);
    assert.strictEqual(metrics.unrealizedPnL, 0); // zero holdings
    assert.strictEqual(metrics.equity, 100060);
    // Total P&L reconciles with realized + unrealized under zero external deposits.
    const totalPnL = roundPrice(metrics.equity - config.startingCapital);
    assert.strictEqual(totalPnL, roundPrice(metrics.realizedPnL + metrics.unrealizedPnL));
    assert.strictEqual(totalPnL, 60);
});

test("fixture: starting inventory sold at a loss reconciles cash/holdings/realizedPnL/equity exactly", () => {
    // A naturally-ARMED sell level is always above the lot's own cost
    // (cost + sellVariance, a positive offset), so it can never naturally
    // represent a loss. applySell's own math is still fully generic over
    // WHICH price triggered it, though — this manually overrides the
    // pending level to below cost to prove that, exactly like the
    // original (pre-ADR-037) dynamic-reference fixture did.
    const config = {
        referencePrice: 94,
        gridInterval: 3,
        quantityPerLevel: 10,
        startingCapital: 100000,
        startingHoldings: 10,
        startingAvgCost: 103,
    };
    let state = createInitialGridState(config);
    assert.strictEqual(state.cash, 100000); // starting capital is independent of inventory cost basis
    state = { ...state, pendingSellLevels: [97] }; // override the natural (always-above-cost) seed for this scenario

    const result = processPriceUpdate({ config, state, price: 97, eventTimestamp: "2026-01-01T09:16:00.000Z" }); // up-cross through the armed 97 level
    state = result.state;

    assert.strictEqual(result.trades.length, 1);
    assert.strictEqual(result.trades[0].type, "SELL");
    assert.strictEqual(result.trades[0].fillPrice, 97);
    assert.strictEqual(result.trades[0].realizedPnLDelta, -60); // 10 * (97 - 103)

    assert.strictEqual(state.holdings, 0);
    assert.strictEqual(state.cash, 100970); // 100000 + 10*97
    assert.strictEqual(state.realizedPnL, -60);
    assert.strictEqual(state.avgCost, 0); // resets once holdings return to zero

    const metrics = computePortfolioMetrics(state, 97);
    assert.strictEqual(metrics.unrealizedPnL, 0);
    assert.strictEqual(metrics.equity, 100970);
});

// --- Dynamic-reference strategy: starting inventory + exact task-spec oscillations ---

test("validateGridConfig requires startingAvgCost only when startingHoldings > 0", () => {
    assert.strictEqual(validateGridConfig({ ...BASE_CONFIG, startingHoldings: 200 }).valid, false);
    assert.strictEqual(validateGridConfig({ ...BASE_CONFIG, startingHoldings: 200, startingAvgCost: 315 }).valid, true);
    assert.strictEqual(validateGridConfig({ ...BASE_CONFIG, startingHoldings: 0 }).valid, true); // no avgCost needed
    assert.strictEqual(validateGridConfig(BASE_CONFIG).valid, true); // startingHoldings omitted entirely
});

test("createInitialGridState seeds holdings/avgCost from starting inventory, the crossing watermark from the captured reference, and both pending-level arrays (ADR-037)", () => {
    const state = createInitialGridState({ ...BASE_CONFIG, startingHoldings: 200, startingAvgCost: 315, referenceCapturedAt: "2026-01-01T09:00:00.000Z" });
    assert.strictEqual(state.holdings, 200);
    assert.strictEqual(state.avgCost, 315);
    assert.strictEqual(state.lastPrice, BASE_CONFIG.referencePrice);
    assert.deepStrictEqual(state.pendingBuyLevels, [337]); // referencePrice(340) - gridInterval(3)
    assert.deepStrictEqual(state.pendingSellLevels, [318]); // startingAvgCost(315) + gridInterval(3) — the starting lot's own sell target
    assert.strictEqual(state.lastEventTimestamp, "2026-01-01T09:00:00.000Z");
});

test("createInitialGridState with zero starting holdings matches the original flat-start behavior exactly", () => {
    const state = createInitialGridState(BASE_CONFIG);
    assert.strictEqual(state.holdings, 0);
    assert.strictEqual(state.avgCost, 0);
    assert.deepStrictEqual(state.pendingSellLevels, []); // nothing to sell yet
});

test("ADR-031 oscillation 320 -> 317 -> 314 -> 317 -> 320 (R=320, G=3): every leg trades, rebasing with it, net profit on the round trip", () => {
    const config = { ...BASE_CONFIG, referencePrice: 320, gridInterval: 3, startingCapital: 1000000 };
    let state = createInitialGridState(config);
    const t = (n) => new Date(2026, 0, 1, 9, n).toISOString();

    const r1 = processPriceUpdate({ config, state, price: 317, eventTimestamp: t(1) }); // buy @317, arms SELL@320, BUY@314
    assert.strictEqual(r1.trades.length, 1);
    assert.strictEqual(r1.trades[0].type, "BUY");
    assert.strictEqual(r1.trades[0].levelPrice, 317);
    assert.deepStrictEqual(r1.state.pendingBuyLevels, [314]);
    assert.deepStrictEqual(r1.state.pendingSellLevels, [320]);
    state = r1.state;

    const r2 = processPriceUpdate({ config, state, price: 314, eventTimestamp: t(2) }); // buy @314, arms SELL@317, BUY@311
    assert.strictEqual(r2.trades.length, 1);
    assert.strictEqual(r2.trades[0].levelPrice, 314);
    assert.deepStrictEqual(r2.state.pendingBuyLevels, [311]);
    assert.deepStrictEqual(r2.state.pendingSellLevels, [320, 317]);
    state = r2.state;

    // Reversal up: the NEARER sell target (317, armed by the 314 buy)
    // fires, not 320.
    const r3 = processPriceUpdate({ config, state, price: 317, eventTimestamp: t(3) });
    assert.strictEqual(r3.trades.length, 1);
    assert.strictEqual(r3.trades[0].type, "SELL");
    assert.strictEqual(r3.trades[0].levelPrice, 317);
    assert.deepStrictEqual(r3.state.pendingBuyLevels, [311, 314]);
    assert.deepStrictEqual(r3.state.pendingSellLevels, [320]);
    state = r3.state;

    const r4 = processPriceUpdate({ config, state, price: 320, eventTimestamp: t(4) }); // continues up through 320
    assert.strictEqual(r4.trades.length, 1);
    assert.strictEqual(r4.trades[0].type, "SELL");
    assert.strictEqual(r4.trades[0].levelPrice, 320);
    state = r4.state;

    assert.strictEqual(state.holdings, 0); // bought 2 lots, sold 2 lots
    assert.strictEqual(state.cash, 1000000 - 100 * 317 - 100 * 314 + 100 * 317 + 100 * 320);
    // Weighted-avg cost after both buys = (317+314)/2 = 315.5; realized P&L
    // = 100*(317-315.5) [first sell] + 100*(320-315.5) [second sell].
    assert.strictEqual(state.realizedPnL, 100 * (317 - 315.5) + 100 * (320 - 315.5));
});

test("multi-level gap 320 -> 330 (R=320, G=3): sells at 323/326/329 each fill at the ACTUAL 330 event price, theoretical level recorded separately, processed lowest-to-highest", () => {
    const config = { ...BASE_CONFIG, referencePrice: 320, gridInterval: 3, startingCapital: 0 };
    const state = { ...createInitialGridState(config), holdings: 300, lots: [{ qty: 300, price: 310 }], avgCost: 310, cash: 0, pendingSellLevels: [323] };
    const result = processPriceUpdate({ config, state, price: 330, eventTimestamp: new Date(2026, 0, 1, 11, 0).toISOString() });

    assert.strictEqual(result.trades.length, 3);
    const expectedLevels = [323, 326, 329]; // lowest to highest for an upward gap
    result.trades.forEach((trade, i) => {
        assert.strictEqual(trade.type, "SELL");
        assert.strictEqual(trade.levelPrice, expectedLevels[i], "theoretical grid level, in ascending order");
        assert.strictEqual(trade.fillPrice, 330, "every fill uses the actual observed event price, never the skipped theoretical level");
        assert.strictEqual(trade.qtyFilled, 100);
    });
    assert.strictEqual(result.state.holdings, 0);
    assert.strictEqual(result.gapFill, true);
});

// --- ADR-032: FIFO lot-based cost basis (replaces weighted-average) ---

test("weightedAvgCost derives the display average from the current lot queue", () => {
    assert.strictEqual(weightedAvgCost([]), 0);
    assert.strictEqual(weightedAvgCost([{ qty: 100, price: 35 }]), 35);
    assert.strictEqual(weightedAvgCost([{ qty: 100, price: 35 }, { qty: 100, price: 30 }]), 32.5);
});

test("consumeLotsFifo consumes the OLDEST lot first, at that lot's own price, never a blended average", () => {
    const lots = [{ qty: 100, price: 35 }, { qty: 100, price: 30 }];
    const { lots: remaining, realizedPnLDelta } = consumeLotsFifo(lots, 100, 40);
    assert.deepStrictEqual(remaining, [{ qty: 100, price: 30 }]); // the 35-lot is gone, the 30-lot untouched
    assert.strictEqual(realizedPnLDelta, 100 * (40 - 35)); // profit measured against the OLDEST lot's own price (35), not the 32.5 blended average
});

test("consumeLotsFifo spans multiple lots when the sell quantity exceeds the oldest lot alone", () => {
    const lots = [{ qty: 50, price: 35 }, { qty: 100, price: 30 }];
    const { lots: remaining, realizedPnLDelta } = consumeLotsFifo(lots, 120, 40);
    assert.deepStrictEqual(remaining, [{ qty: 30, price: 30 }]); // 50 from lot 1 (all of it) + 70 from lot 2
    const expected = roundPrice(50 * (40 - 35) + 70 * (40 - 30));
    assert.strictEqual(realizedPnLDelta, expected);
});

test("FIFO worked example: buy 100@35, buy 100@30, then two sells — the engine fills the FIRST lot's order, not the cheapest or a blended average", () => {
    const config = { referencePrice: 40, gridInterval: 5, quantityPerLevel: 100, startingCapital: 1000000, commissionPct: 0, slippagePct: 0 };
    let state = createInitialGridState(config);
    let t = Date.parse("2026-01-01T09:00:00.000Z");

    let r = processPriceUpdate({ config, state, price: 35, eventTimestamp: new Date(t += 1000).toISOString() }); // BUY 100@35
    state = r.state;
    r = processPriceUpdate({ config, state, price: 30, eventTimestamp: new Date(t += 1000).toISOString() }); // BUY 100@30
    state = r.state;
    assert.deepStrictEqual(state.lots, [{ qty: 100, price: 35 }, { qty: 100, price: 30 }]);
    assert.strictEqual(state.avgCost, 32.5); // display-only weighted average

    // Up-cross through 35 (sells the FIRST lot, bought @35 — zero profit,
    // NOT the 32.5 blended average which would show a small profit here).
    r = processPriceUpdate({ config, state, price: 35, eventTimestamp: new Date(t += 1000).toISOString() });
    assert.strictEqual(r.trades[0].type, "SELL");
    assert.strictEqual(r.trades[0].qtyFilled, 100);
    assert.strictEqual(r.trades[0].realizedPnLDelta, 0); // sold @35, bought that exact lot @35
    state = r.state;
    assert.deepStrictEqual(state.lots, [{ qty: 100, price: 30 }]);

    // Up-cross through 40 (sells the remaining lot, bought @30 -> real profit).
    r = processPriceUpdate({ config, state, price: 40, eventTimestamp: new Date(t += 1000).toISOString() });
    assert.strictEqual(r.trades[0].realizedPnLDelta, 100 * (40 - 30));
    state = r.state;
    assert.strictEqual(state.lots.length, 0);
    assert.strictEqual(state.avgCost, 0);
    assert.strictEqual(state.realizedPnL, 0 + 100 * (40 - 30));
});

test("a partial sell consumes only PART of the oldest lot, leaving the remainder at its original price (not re-averaged)", () => {
    const config = { referencePrice: 100, gridInterval: 3, quantityPerLevel: 60, startingCapital: 1000000, commissionPct: 0, slippagePct: 0 };
    let state = createInitialGridState(config);
    let t = Date.parse("2026-01-01T09:00:00.000Z");

    let r = processPriceUpdate({ config, state, price: 97, eventTimestamp: new Date(t += 1000).toISOString() }); // BUY 60@97
    state = r.state;
    assert.deepStrictEqual(state.lots, [{ qty: 60, price: 97 }]);

    // A second, smaller BUY lot at a different price.
    const config2 = { ...config, quantityPerLevel: 20 };
    r = processPriceUpdate({ config: config2, state, price: 94, eventTimestamp: new Date(t += 1000).toISOString() }); // BUY 20@94
    state = r.state;
    assert.deepStrictEqual(state.lots, [{ qty: 60, price: 97 }, { qty: 20, price: 94 }]);

    // Sell only 40 — partially consumes the FIRST (oldest, 97) lot only.
    const sellConfig = { ...config, quantityPerLevel: 40, referencePrice: 94 };
    r = processPriceUpdate({ config: sellConfig, state, price: 97, eventTimestamp: new Date(t += 1000).toISOString() });
    assert.strictEqual(r.trades[0].type, "SELL");
    assert.strictEqual(r.trades[0].qtyFilled, 40);
    assert.strictEqual(r.trades[0].realizedPnLDelta, 40 * (97 - 97)); // consumed from the 97 lot only
    state = r.state;
    assert.deepStrictEqual(state.lots, [{ qty: 20, price: 97 }, { qty: 20, price: 94 }]); // 20 left of the first lot, untouched 94 lot
});

test("validateGridConfig rejects a non-positive sellVariance but accepts a positive one", () => {
    const base = { referencePrice: 100, gridInterval: 3, quantityPerLevel: 10, startingCapital: 1000 };
    assert.strictEqual(validateGridConfig({ ...base, sellVariance: -1 }).valid, false);
    assert.strictEqual(validateGridConfig({ ...base, sellVariance: 5 }).valid, true);
    assert.strictEqual(validateGridConfig(base).valid, true); // omitted entirely is fine (mirrors gridInterval)
});

test("ADR-034: asymmetric buy/sell variance — BUY steps use gridInterval, SELL steps use sellVariance", () => {
    const config = { referencePrice: 100, gridInterval: 3, sellVariance: 5, quantityPerLevel: 10, startingCapital: 1000000, commissionPct: 0, slippagePct: 0 };
    let state = createInitialGridState(config);
    let t = Date.parse("2026-01-01T09:00:00.000Z");

    // Down-cross 3 (buy variance) from 100 -> BUY at 97, arms SELL@102 (97+5).
    let r = processPriceUpdate({ config, state, price: 97, eventTimestamp: new Date(t += 1000).toISOString() });
    assert.strictEqual(r.trades.length, 1);
    assert.strictEqual(r.trades[0].type, "BUY");
    assert.strictEqual(r.trades[0].levelPrice, 97);
    state = r.state;
    assert.deepStrictEqual(state.pendingSellLevels, [102]);

    // Up-cross 5 (sell variance, NOT 3) from 97 -> SELL at 102, arms BUY@99 (102-3).
    r = processPriceUpdate({ config, state, price: 102, eventTimestamp: new Date(t += 1000).toISOString() });
    assert.strictEqual(r.trades.length, 1);
    assert.strictEqual(r.trades[0].type, "SELL");
    assert.strictEqual(r.trades[0].levelPrice, 102);
    state = r.state;
    assert.deepStrictEqual(state.pendingBuyLevels, [94, 99]);

    // Down-cross 3 (buy variance) from 102 -> BUY at 99, arms SELL@104 (99+5).
    r = processPriceUpdate({ config, state, price: 99, eventTimestamp: new Date(t += 1000).toISOString() });
    assert.strictEqual(r.trades.length, 1);
    assert.strictEqual(r.trades[0].type, "BUY");
    assert.strictEqual(r.trades[0].levelPrice, 99);
    state = r.state;
    assert.deepStrictEqual(state.pendingSellLevels, [107, 104]);
});

test("ADR-034: sellVariance omitted (null) mirrors gridInterval exactly — identical to the pre-ADR-034 symmetric behavior", () => {
    const symmetricConfig = { referencePrice: 100, gridInterval: 3, quantityPerLevel: 10, startingCapital: 1000000, commissionPct: 0, slippagePct: 0 };
    const mirroredConfig = { ...symmetricConfig, sellVariance: null };
    let stateA = createInitialGridState(symmetricConfig);
    let stateB = createInitialGridState(mirroredConfig);
    let t = Date.parse("2026-01-01T09:00:00.000Z");

    [97, 100, 103, 100].forEach((price) => {
        t += 1000;
        const eventTimestamp = new Date(t).toISOString();
        const rA = processPriceUpdate({ config: symmetricConfig, state: stateA, price, eventTimestamp });
        const rB = processPriceUpdate({ config: mirroredConfig, state: stateB, price, eventTimestamp });
        assert.deepStrictEqual(rA.trades, rB.trades);
        stateA = rA.state;
        stateB = rB.state;
    });
    assert.deepStrictEqual(stateA, stateB);
});

test("validateGridConfig rejects a non-positive sellQuantityPerLevel but accepts a positive integer", () => {
    const base = { referencePrice: 100, gridInterval: 3, quantityPerLevel: 10, startingCapital: 1000 };
    assert.strictEqual(validateGridConfig({ ...base, sellQuantityPerLevel: -1 }).valid, false);
    assert.strictEqual(validateGridConfig({ ...base, sellQuantityPerLevel: 1.5 }).valid, false);
    assert.strictEqual(validateGridConfig({ ...base, sellQuantityPerLevel: 4 }).valid, true);
    assert.strictEqual(validateGridConfig(base).valid, true); // omitted entirely is fine (mirrors quantityPerLevel)
});

test("ADR-035: asymmetric buy/sell quantity — BUY fills use quantityPerLevel, SELL fills use sellQuantityPerLevel", () => {
    const config = { referencePrice: 100, gridInterval: 3, quantityPerLevel: 10, sellQuantityPerLevel: 4, startingCapital: 1000000, commissionPct: 0, slippagePct: 0 };
    let state = createInitialGridState(config);
    let t = Date.parse("2026-01-01T09:00:00.000Z");

    let r = processPriceUpdate({ config, state, price: 97, eventTimestamp: new Date(t += 1000).toISOString() }); // down-cross -> BUY
    assert.strictEqual(r.trades[0].type, "BUY");
    assert.strictEqual(r.trades[0].qtyFilled, 10);
    state = r.state;
    assert.strictEqual(state.holdings, 10);

    r = processPriceUpdate({ config, state, price: 100, eventTimestamp: new Date(t += 1000).toISOString() }); // up-cross -> SELL
    assert.strictEqual(r.trades[0].type, "SELL");
    assert.strictEqual(r.trades[0].qtyFilled, 4);
    state = r.state;
    assert.strictEqual(state.holdings, 6);
});

test("ADR-035: sellQuantityPerLevel omitted (null) mirrors quantityPerLevel exactly — identical to the pre-ADR-035 symmetric behavior", () => {
    const symmetricConfig = { referencePrice: 100, gridInterval: 3, quantityPerLevel: 10, startingCapital: 1000000, commissionPct: 0, slippagePct: 0 };
    const mirroredConfig = { ...symmetricConfig, sellQuantityPerLevel: null };
    let stateA = createInitialGridState(symmetricConfig);
    let stateB = createInitialGridState(mirroredConfig);
    let t = Date.parse("2026-01-01T09:00:00.000Z");

    [97, 100, 103, 100].forEach((price) => {
        t += 1000;
        const eventTimestamp = new Date(t).toISOString();
        const rA = processPriceUpdate({ config: symmetricConfig, state: stateA, price, eventTimestamp });
        const rB = processPriceUpdate({ config: mirroredConfig, state: stateB, price, eventTimestamp });
        assert.deepStrictEqual(rA.trades, rB.trades);
        stateA = rA.state;
        stateB = rB.state;
    });
    assert.deepStrictEqual(stateA, stateB);
});

// --- ADR-040: optional price limits (pause BUYs/SELLs beyond a band) ---

test("validateGridConfig rejects a non-positive lowerLimit/upperLimit, and an inverted/equal band", () => {
    assert.strictEqual(validateGridConfig({ ...BASE_CONFIG, lowerLimit: 0 }).valid, false);
    assert.strictEqual(validateGridConfig({ ...BASE_CONFIG, upperLimit: -5 }).valid, false);
    assert.strictEqual(validateGridConfig({ ...BASE_CONFIG, lowerLimit: 330, upperLimit: 330 }).valid, false);
    assert.strictEqual(validateGridConfig({ ...BASE_CONFIG, lowerLimit: 340, upperLimit: 330 }).valid, false);
    assert.strictEqual(validateGridConfig({ ...BASE_CONFIG, lowerLimit: 330, upperLimit: 350 }).valid, true);
    assert.strictEqual(validateGridConfig(BASE_CONFIG).valid, true); // both omitted -> no limit, still valid
});

test("a lowerLimit pauses BUYs once price is at/below it, and resumes automatically once price recovers above it", () => {
    const config = { referencePrice: 50, gridInterval: 2, quantityPerLevel: 10, startingCapital: 1000000, lowerLimit: 45 };
    let state = createInitialGridState(config);
    const t = (n) => new Date(2026, 0, 1, 9, n).toISOString();

    let r = processPriceUpdate({ config, state, price: 48, eventTimestamp: t(1) }); // BUY@48, arms BUY@46
    state = r.state;
    assert.strictEqual(r.trades.length, 1);

    r = processPriceUpdate({ config, state, price: 44, eventTimestamp: t(2) }); // 44 <= 45 -> paused, BUY@46 stays pending
    state = r.state;
    assert.strictEqual(r.trades.length, 0);
    assert.deepStrictEqual(state.pendingBuyLevels, [46]);

    r = processPriceUpdate({ config, state, price: 47, eventTimestamp: t(3) }); // up move, nothing to sell, just repositions
    state = r.state;
    assert.strictEqual(r.trades.length, 0);

    r = processPriceUpdate({ config, state, price: 45.5, eventTimestamp: t(4) }); // down through 46, price (45.5) > lowerLimit -> resumes
    state = r.state;
    assert.strictEqual(r.trades.length, 1);
    assert.strictEqual(r.trades[0].type, "BUY");
    assert.strictEqual(r.trades[0].fillPrice, 45.5);
});

test("an upperLimit pauses SELLs once price is at/above it, and resumes automatically once price pulls back below it", () => {
    const config = { referencePrice: 50, gridInterval: 2, quantityPerLevel: 10, startingCapital: 1000000, startingHoldings: 10, startingAvgCost: 50, upperLimit: 53 };
    let state = createInitialGridState(config); // seeds a pending sell at 50+2=52
    const t = (n) => new Date(2026, 0, 1, 9, n).toISOString();

    let r = processPriceUpdate({ config, state, price: 60, eventTimestamp: t(1) }); // straight through 52, but 60 >= 53 -> paused
    state = r.state;
    assert.strictEqual(r.trades.length, 0);
    assert.deepStrictEqual(state.pendingSellLevels, [52]);

    r = processPriceUpdate({ config, state, price: 51.5, eventTimestamp: t(2) }); // down move, irrelevant to sells
    state = r.state;
    assert.strictEqual(r.trades.length, 0);

    r = processPriceUpdate({ config, state, price: 52, eventTimestamp: t(3) }); // up to 52 (< 53) -> resumes
    state = r.state;
    assert.strictEqual(r.trades.length, 1);
    assert.strictEqual(r.trades[0].type, "SELL");
    assert.strictEqual(r.trades[0].fillPrice, 52);
});

console.log(`\nGrid simulator engine tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
