/**
 * Grid Trading Simulator — tests for services/gridChargesCalculator.js
 * (ADR-035, rates corrected/expanded in ADR-036). Pure module, no DB/
 * network — plain Node `assert`, same tiny harness convention as the rest
 * of this backend's test suite.
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

test("classifySegmentClass recognizes equity futures by instrumentType or NSE/BSE FO segment", () => {
    assert.strictEqual(classifySegmentClass({ instrumentType: "FUTSTK" }), "FUTURES");
    assert.strictEqual(classifySegmentClass({ segment: "NSE_FO", type: "FUTSTK" }), "FUTURES");
});

test("classifySegmentClass splits MCX into COMMODITY_FUTURES vs COMMODITY_OPTIONS — never falls back to the equity F&O rates", () => {
    assert.strictEqual(classifySegmentClass({ segment: "MCX_FO", type: "FUT" }), "COMMODITY_FUTURES");
    assert.strictEqual(classifySegmentClass({ segment: "MCX_FO", type: "CE" }), "COMMODITY_OPTIONS");
    assert.strictEqual(classifySegmentClass({ segment: "MCX_FO", type: "PE" }), "COMMODITY_OPTIONS");
});

test("classifySegmentClass also treats NSE's own commodity segment (NSE_COM) as commodity, not equity futures (real bug found via a live backfill)", () => {
    assert.strictEqual(classifySegmentClass({ segment: "NSE_COM", type: "FUT" }), "COMMODITY_FUTURES");
    assert.strictEqual(classifySegmentClass({ segment: "NSE_COM", type: "CE" }), "COMMODITY_OPTIONS");
});

test("classifySegmentClass defaults to EQUITY_DELIVERY ('normal') for plain equity and unrecognized input", () => {
    assert.strictEqual(classifySegmentClass({ segment: "NSE_EQ" }), "EQUITY_DELIVERY");
    assert.strictEqual(classifySegmentClass(null), "EQUITY_DELIVERY");
    assert.strictEqual(classifySegmentClass(undefined), "EQUITY_DELIVERY");
});

test("equity delivery: zero brokerage, 0.1% STT on both buy and sell, 0.015% stamp duty buy-only", () => {
    const buy = chargesForTrade({ type: "BUY", effectivePrice: 100, qtyFilled: 100 }, "EQUITY_DELIVERY"); // turnover 10000
    const sell = chargesForTrade({ type: "SELL", effectivePrice: 100, qtyFilled: 100 }, "EQUITY_DELIVERY");
    assert.strictEqual(buy.brokerage, 0);
    assert.strictEqual(sell.brokerage, 0);
    assert.strictEqual(buy.stt, 10); // 0.1% of 10000
    assert.strictEqual(sell.stt, 10);
    assert.strictEqual(Math.round(buy.stampDuty * 10000) / 10000, 1.5); // 0.015% of 10000
    assert.strictEqual(sell.stampDuty, 0, "stamp duty never applies to the sell side");
});

test("equity futures & commodity futures: brokerage is min(0.03% of turnover, ₹20) — not a flat ₹20", () => {
    const small = chargesForTrade({ type: "SELL", effectivePrice: 100, qtyFilled: 50 }, "FUTURES"); // turnover 5000, 0.03% = 1.5
    assert.strictEqual(Math.round(small.brokerage * 100) / 100, 1.5);

    const large = chargesForTrade({ type: "SELL", effectivePrice: 1000, qtyFilled: 1000 }, "FUTURES"); // turnover 1,000,000, 0.03% = 300 -> capped at 20
    assert.strictEqual(large.brokerage, 20);

    const commodityLarge = chargesForTrade({ type: "SELL", effectivePrice: 1000, qtyFilled: 1000 }, "COMMODITY_FUTURES");
    assert.strictEqual(commodityLarge.brokerage, 20);
});

test("equity options & commodity options: flat ₹20 brokerage per executed order regardless of turnover", () => {
    const optSmall = chargesForTrade({ type: "BUY", effectivePrice: 5, qtyFilled: 10 }, "OPTIONS");
    const optLarge = chargesForTrade({ type: "BUY", effectivePrice: 5000, qtyFilled: 500 }, "OPTIONS");
    assert.strictEqual(optSmall.brokerage, 20);
    assert.strictEqual(optLarge.brokerage, 20);

    const comOpt = chargesForTrade({ type: "BUY", effectivePrice: 100, qtyFilled: 50 }, "COMMODITY_OPTIONS");
    assert.strictEqual(comOpt.brokerage, 20);
});

test("STT/CTT applies only to the correct side per segment", () => {
    assert.strictEqual(chargesForTrade({ type: "BUY", effectivePrice: 100, qtyFilled: 50 }, "FUTURES").stt, 0);
    assert.ok(chargesForTrade({ type: "SELL", effectivePrice: 100, qtyFilled: 50 }, "FUTURES").stt > 0);
    assert.strictEqual(chargesForTrade({ type: "BUY", effectivePrice: 100, qtyFilled: 50 }, "OPTIONS").stt, 0);
    assert.ok(chargesForTrade({ type: "SELL", effectivePrice: 100, qtyFilled: 50 }, "OPTIONS").stt > 0);
    assert.strictEqual(chargesForTrade({ type: "BUY", effectivePrice: 5000, qtyFilled: 10 }, "COMMODITY_FUTURES").stt, 0);
    assert.ok(chargesForTrade({ type: "SELL", effectivePrice: 5000, qtyFilled: 10 }, "COMMODITY_FUTURES").stt > 0);
});

test("GST is exactly 18% of (brokerage + exchange txn charges + SEBI fee) — never includes STT or stamp duty", () => {
    const trade = { type: "BUY", effectivePrice: 100, qtyFilled: 100 };
    const c = chargesForTrade(trade, "EQUITY_DELIVERY");
    const expectedGst = 0.18 * (c.brokerage + c.exchangeTxnCharges + c.sebiFee);
    assert.ok(Math.abs(c.gst - expectedGst) < 1e-9);

    const futTrade = chargesForTrade({ type: "SELL", effectivePrice: 1000, qtyFilled: 1000 }, "FUTURES");
    const expectedFutGst = 0.18 * (futTrade.brokerage + futTrade.exchangeTxnCharges + futTrade.sebiFee);
    assert.ok(Math.abs(futTrade.gst - expectedFutGst) < 1e-9);
});

test("a trade with zero qtyFilled or zero price never incurs any charge", () => {
    const zeroQty = chargesForTrade({ type: "BUY", effectivePrice: 100, qtyFilled: 0 }, "FUTURES");
    assert.deepStrictEqual(zeroQty, { brokerage: 0, stt: 0, exchangeTxnCharges: 0, sebiFee: 0, stampDuty: 0, gst: 0, total: 0 });
});

test("summarizeCharges sums every component (including gst) across every FILLED trade and skips fully-skipped (qtyFilled: 0) trades", () => {
    const trades = [
        { type: "BUY", effectivePrice: 100, qtyFilled: 100 },
        { type: "SELL", effectivePrice: 105, qtyFilled: 100 },
        { type: "BUY", effectivePrice: 100, qtyFilled: 0, qtySkipped: 100 }, // fully skipped — never charged
    ];
    const summary = summarizeCharges(trades, "EQUITY_DELIVERY");
    const buyCharges = chargesForTrade(trades[0], "EQUITY_DELIVERY");
    const sellCharges = chargesForTrade(trades[1], "EQUITY_DELIVERY");
    assert.strictEqual(summary.total, Math.round((buyCharges.total + sellCharges.total) * 100) / 100);
    assert.strictEqual(summary.gst, Math.round((buyCharges.gst + sellCharges.gst) * 100) / 100);
    assert.strictEqual(summary.brokerage, buyCharges.brokerage + sellCharges.brokerage);
});

test("summarizeCharges flags approximate:false for all 6 modeled segments, true for anything else", () => {
    ["EQUITY_DELIVERY", "EQUITY_INTRADAY", "FUTURES", "OPTIONS", "COMMODITY_FUTURES", "COMMODITY_OPTIONS"].forEach((segmentClass) => {
        assert.strictEqual(summarizeCharges([], segmentClass).approximate, false, segmentClass);
    });
    assert.strictEqual(summarizeCharges([], "SOMETHING_ELSE").approximate, true);
});

console.log(`\nGrid charges calculator tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
