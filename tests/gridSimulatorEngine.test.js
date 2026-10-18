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
    findCrossedLevels,
    processPriceUpdate,
    computePortfolioMetrics,
    toCents,
    levelPrice,
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

test("findCrossedLevels finds a single downward level between two prices", () => {
    const levels = findCrossedLevels(BASE_CONFIG, toCents(340), toCents(336));
    assert.deepStrictEqual(levels, [-1]); // 337 only
});

test("findCrossedLevels finds multiple levels in traversal order for a gap", () => {
    const down = findCrossedLevels(BASE_CONFIG, toCents(340), toCents(310));
    assert.deepStrictEqual(down, [-1, -2, -3, -4, -5, -6, -7, -8, -9, -10]); // 337..310

    const up = findCrossedLevels(BASE_CONFIG, toCents(340), toCents(350));
    assert.deepStrictEqual(up, [1, 2, 3]); // 343,346,349
});

test("findCrossedLevels includes the exact boundary (inclusive both ends) so a level can re-arm when touched and reversed", () => {
    // Moving from exactly 337 further down to 334 re-includes 337 in the
    // raw level-crossing list (harmless at the pure level-finding layer —
    // processPriceUpdate's armed-state check is what prevents a duplicate
    // trade; see the dedicated re-arm tests below for that behavior).
    const levels = findCrossedLevels(BASE_CONFIG, toCents(337), toCents(334));
    assert.deepStrictEqual(levels, [-1, -2]);
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

test("a single upward crossing sells at the actual tick price when holdings are available", () => {
    let state = createInitialGridState(BASE_CONFIG);
    state = processPriceUpdate({ config: BASE_CONFIG, state, price: 336, eventTimestamp: tick(1) }).state; // buy 100 @ 336

    // Price rises past the 343 sell level up to 345 (actual event price).
    const result = processPriceUpdate({ config: BASE_CONFIG, state, price: 345, eventTimestamp: tick(2) });
    assert.strictEqual(result.trades.length, 1);
    const [trade] = result.trades;
    assert.strictEqual(trade.type, "SELL");
    assert.strictEqual(trade.level, 1);
    assert.strictEqual(trade.levelPrice, 343);
    assert.strictEqual(trade.fillPrice, 345);
    assert.strictEqual(trade.qtyFilled, 100);
    assert.strictEqual(result.state.holdings, 0);
    assert.strictEqual(result.state.avgCost, 0); // reset when flat
    assert.strictEqual(result.state.realizedPnL, 100 * (345 - 336));
});

// --- re-arming / repeated oscillations ---

test("a level does not re-trigger without an intervening opposite-direction crossing", () => {
    let state = createInitialGridState(BASE_CONFIG);
    state = processPriceUpdate({ config: BASE_CONFIG, state, price: 336, eventTimestamp: tick(1) }).state; // buys @ 337

    // Price wiggles further down and back up WITHOUT crossing back above 337.
    state = processPriceUpdate({ config: BASE_CONFIG, state, price: 335.5, eventTimestamp: tick(2) }).state;
    const noRetrigger = processPriceUpdate({ config: BASE_CONFIG, state, price: 336.2, eventTimestamp: tick(3) });
    assert.strictEqual(noRetrigger.trades.length, 0);
    assert.strictEqual(noRetrigger.state.holdings, 100); // unchanged, no duplicate buy
});

test("a level re-arms after crossing back over it and can trigger again on the next oscillation", () => {
    let state = createInitialGridState(BASE_CONFIG);
    state = processPriceUpdate({ config: BASE_CONFIG, state, price: 336, eventTimestamp: tick(1) }).state; // buy @337, disarm

    state = processPriceUpdate({ config: BASE_CONFIG, state, price: 338, eventTimestamp: tick(2) }).state; // crosses 337 upward -> re-arm, no trade
    assert.strictEqual(state.holdings, 100);

    const second = processPriceUpdate({ config: BASE_CONFIG, state, price: 336, eventTimestamp: tick(3) }); // crosses 337 downward again -> trigger
    assert.strictEqual(second.trades.length, 1);
    assert.strictEqual(second.trades[0].level, -1);
    assert.strictEqual(second.state.holdings, 200);
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

test("insufficient cash: full skip when not even one share is affordable, and it does not retry on the next tick without a re-arm", () => {
    const config = { ...BASE_CONFIG, startingCapital: 100 };
    let state = createInitialGridState(config);
    const first = processPriceUpdate({ config, state, price: 337, eventTimestamp: tick(1) });
    assert.strictEqual(first.trades[0].qtyFilled, 0);
    assert.strictEqual(first.trades[0].qtySkipped, 100);
    assert.strictEqual(first.trades[0].reason, "insufficient_cash");

    // Price stays below 337 on the next tick — must NOT retry/duplicate-skip-log the same level.
    const second = processPriceUpdate({ config, state: first.state, price: 336, eventTimestamp: tick(2) });
    assert.strictEqual(second.trades.length, 0);
});

test("a cash-skipped level can trigger again after a genuine re-arming crossing", () => {
    const config = { ...BASE_CONFIG, startingCapital: 100 };
    let state = createInitialGridState(config);
    state = processPriceUpdate({ config, state, price: 337, eventTimestamp: tick(1) }).state; // skipped, disarmed
    state = processPriceUpdate({ config, state, price: 338, eventTimestamp: tick(2) }).state; // re-arm
    const result = processPriceUpdate({ config, state, price: 337, eventTimestamp: tick(3) }); // re-trigger
    assert.strictEqual(result.trades.length, 1);
    assert.strictEqual(result.trades[0].level, -1);
});

// --- insufficient virtual holdings ---

test("insufficient holdings: partial sell fills only what is held, never goes negative", () => {
    const config = { ...BASE_CONFIG };
    let state = createInitialGridState(config);
    state = { ...state, holdings: 50, avgCost: 300, cash: 50000 };
    const result = processPriceUpdate({ config, state, price: 345, eventTimestamp: tick(1) }); // crosses 343 up
    assert.strictEqual(result.trades[0].type, "SELL");
    assert.strictEqual(result.trades[0].qtyFilled, 50);
    assert.strictEqual(result.trades[0].qtySkipped, 50);
    assert.strictEqual(result.trades[0].reason, "insufficient_holdings_partial");
    assert.strictEqual(result.state.holdings, 0);
    assert.ok(result.state.holdings >= 0);
});

test("insufficient holdings: zero holdings produces a full skip, not a negative position", () => {
    const state = createInitialGridState(BASE_CONFIG);
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

// --- commission/slippage: hand-verified accounting ---

test("commission and slippage are applied exactly as hand-calculated (fees disclosed, not invented)", () => {
    const config = { ...BASE_CONFIG, referencePrice: 100, gridInterval: 3, startingCapital: 100000, commissionPct: 1, slippagePct: 0.5 };
    const state = createInitialGridState(config);
    const result = processPriceUpdate({ config, state, price: 97, eventTimestamp: tick(1) }); // crosses level 97 (n=-1)

    // Hand calculation:
    // effectivePrice = 97 * 1.005 = 97.485 -> rounds to 97.49 (paise precision)
    // unitCost = 97.49 * 1.01 = 98.4649 -> rounds to 98.46
    // qty = 100 (affordable: floor(100000/98.46) = 1015 >= 100)
    // cost = 100 * 98.46 = 9846.00
    const trade = result.trades[0];
    assert.strictEqual(trade.effectivePrice, 97.49);
    assert.strictEqual(trade.qtyFilled, 100);
    assert.strictEqual(result.state.cash, 100000 - 9846);
    assert.strictEqual(result.state.avgCost, 98.46);
});

test("commission reduces sell proceeds exactly as hand-calculated", () => {
    const config = { ...BASE_CONFIG, referencePrice: 100, gridInterval: 3, startingCapital: 0, commissionPct: 1, slippagePct: 0 };
    let state = createInitialGridState(config);
    state = { ...state, holdings: 100, avgCost: 90, cash: 0 };
    const result = processPriceUpdate({ config, state, price: 104, eventTimestamp: tick(1) }); // crosses 103 (n=1)

    // unitProceeds = 104 * (1 - 0.01) = 102.96
    // proceeds = 100 * 102.96 = 10296
    // realizedPnLDelta = 100 * (102.96 - 90) = 1296
    const trade = result.trades[0];
    assert.strictEqual(trade.effectivePrice, 104);
    assert.strictEqual(result.state.cash, 10296);
    assert.strictEqual(result.state.realizedPnL, 1296);
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

console.log(`\nGrid simulator engine tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
