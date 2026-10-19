/**
 * Grid Trading Simulator — tests for services/gridChargesCalculator.js
 * (ADR-035). Pure module, no DB/network — plain Node `assert`, same tiny
 * harness convention as the rest of this backend's test suite.
 */
const assert = require("assert");
const { classifySegmentClass, chargesForTrade, summarizeCharges } = require("../services/gridChargesCalculator");

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

test("classifySegmentClass recognizes options by instrumentType and by CE/PE/CALL/PUT", () => {
    assert.strictEqual(classifySegmentClass({ instrumentType: "OPTSTK" }), "OPTIONS");
    assert.strictEqual(classifySegmentClass({ type: "CE" }), "OPTIONS");
    assert.strictEqual(classifySegmentClass({ type: "PE" }), "OPTIONS");
    assert.strictEqual(classifySegmentClass({ type: "CALL" }), "OPTIONS");
    assert.strictEqual(classifySegmentClass({ type: "PUT" }), "OPTIONS");
});

test("classifySegmentClass recognizes futures by instrumentType and falls back to FUTURES for any other F&O-like segment (e.g. MCX)", () => {
    assert.strictEqual(classifySegmentClass({ instrumentType: "FUTSTK" }), "FUTURES");
    assert.strictEqual(classifySegmentClass({ segment: "NSE_FO" }), "FUTURES");
    assert.strictEqual(classifySegmentClass({ segment: "MCX_FO" }), "FUTURES");
});

test("classifySegmentClass defaults to EQUITY_DELIVERY ('normal') for plain equity and unrecognized input", () => {
    assert.strictEqual(classifySegmentClass({ segment: "NSE_EQ" }), "EQUITY_DELIVERY");
    assert.strictEqual(classifySegmentClass(null), "EQUITY_DELIVERY");
    assert.strictEqual(classifySegmentClass(undefined), "EQUITY_DELIVERY");
});

test("equity delivery: zero brokerage, STT on both buy and sell", () => {
    const buy = chargesForTrade({ type: "BUY", effectivePrice: 100, qtyFilled: 100 }, "EQUITY_DELIVERY");
    const sell = chargesForTrade({ type: "SELL", effectivePrice: 100, qtyFilled: 100 }, "EQUITY_DELIVERY");
    assert.strictEqual(buy.brokerage, 0);
    assert.strictEqual(sell.brokerage, 0);
    // turnover = 100 * 100 = 10000; STT 0.1% = 10
    assert.strictEqual(buy.stt, 10);
    assert.strictEqual(sell.stt, 10);
    assert.ok(buy.stampDuty > 0, "stamp duty applies to the buy side");
    assert.strictEqual(sell.stampDuty, 0, "stamp duty never applies to the sell side");
});

test("futures & options: flat ₹20 brokerage per executed order (the exact values given for this feature), STT sell-side only", () => {
    const futBuy = chargesForTrade({ type: "BUY", effectivePrice: 100, qtyFilled: 50 }, "FUTURES");
    const futSell = chargesForTrade({ type: "SELL", effectivePrice: 100, qtyFilled: 50 }, "FUTURES");
    assert.strictEqual(futBuy.brokerage, 20);
    assert.strictEqual(futSell.brokerage, 20);
    assert.strictEqual(futBuy.stt, 0, "futures STT never applies to the buy side");
    assert.ok(futSell.stt > 0);

    const optBuy = chargesForTrade({ type: "BUY", effectivePrice: 50, qtyFilled: 75 }, "OPTIONS");
    assert.strictEqual(optBuy.brokerage, 20);
});

test("a trade with zero qtyFilled or zero price never incurs any charge", () => {
    const zeroQty = chargesForTrade({ type: "BUY", effectivePrice: 100, qtyFilled: 0 }, "FUTURES");
    assert.deepStrictEqual(zeroQty, { brokerage: 0, stt: 0, exchangeTxnCharges: 0, sebiFee: 0, stampDuty: 0, total: 0 });
});

test("summarizeCharges sums across every FILLED trade and skips fully-skipped (qtyFilled: 0) trades", () => {
    const trades = [
        { type: "BUY", effectivePrice: 100, qtyFilled: 100 },
        { type: "SELL", effectivePrice: 105, qtyFilled: 100 },
        { type: "BUY", effectivePrice: 100, qtyFilled: 0, qtySkipped: 100 }, // fully skipped — never charged
    ];
    const summary = summarizeCharges(trades, "EQUITY_DELIVERY");
    const buyCharges = chargesForTrade(trades[0], "EQUITY_DELIVERY");
    const sellCharges = chargesForTrade(trades[1], "EQUITY_DELIVERY");
    assert.strictEqual(summary.total, Math.round((buyCharges.total + sellCharges.total) * 100) / 100);
    assert.strictEqual(summary.brokerage, buyCharges.brokerage + sellCharges.brokerage);
});

test("summarizeCharges flags approximate:true for any segment outside the 3 modeled ones, false for the modeled ones", () => {
    assert.strictEqual(summarizeCharges([], "EQUITY_DELIVERY").approximate, false);
    assert.strictEqual(summarizeCharges([], "FUTURES").approximate, false);
    assert.strictEqual(summarizeCharges([], "OPTIONS").approximate, false);
    assert.strictEqual(summarizeCharges([], "SOMETHING_ELSE").approximate, true);
});

console.log(`\nGrid charges calculator tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
