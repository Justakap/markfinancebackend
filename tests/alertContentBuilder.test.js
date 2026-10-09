/**
 * Workstream K — pure notification-text builder tests. Verifies the
 * explicit signal-vs-simulated-fill distinction (milestone §2) and that
 * no fill notification could ever be misread as a real broker execution
 * (milestone §2: "do not notify users that an order was executed at a
 * broker").
 */
const assert = require("assert");
const { buildNotificationContent } = require("../services/alertContentBuilder");

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
        console.error(`    ${error.message}`);
    }
}

const runtime = { symbol: "TESTSTOCK", timeframe: "1d" };

console.log("Workstream K — alertContentBuilder\n");

test("ENTRY_SIGNAL is marked isFill:false and explicitly says no position has opened yet", () => {
    const content = buildNotificationContent({ signal: { type: "ENTRY_SIGNAL" }, runtime, strategyName: "My RSI Strategy" });
    assert.strictEqual(content.isFill, false);
    assert.ok(content.body.includes("signal only"));
    assert.ok(content.body.toLowerCase().includes("no simulated position"));
});

test("EXIT_SIGNAL is marked isFill:false", () => {
    const content = buildNotificationContent({ signal: { type: "EXIT_SIGNAL" }, runtime, strategyName: "My RSI Strategy" });
    assert.strictEqual(content.isFill, false);
    assert.ok(content.body.includes("signal only"));
});

test("ENTRY_FILLED is marked isFill:true and explicitly says SIMULATED / no real order", () => {
    const content = buildNotificationContent({ signal: { type: "ENTRY_FILLED", price: 103.456, quantity: 10 }, runtime, strategyName: "My RSI Strategy" });
    assert.strictEqual(content.isFill, true);
    assert.ok(content.body.includes("SIMULATED"));
    assert.ok(content.body.toLowerCase().includes("no real order"));
    assert.ok(content.body.includes("103.46")); // formatted price
});

test("EXIT_FILLED includes the exit reason in plain language and the net P&L", () => {
    const content = buildNotificationContent({
        signal: { type: "EXIT_FILLED", price: 89, quantity: 10, exitReason: "STOP_LOSS", netPnl: -142.5, returnPct: -4.2 },
        runtime,
        strategyName: "My RSI Strategy",
    });
    assert.strictEqual(content.isFill, true);
    assert.ok(content.body.includes("stop-loss"));
    assert.ok(content.body.includes("-142.50"));
    assert.ok(content.body.toLowerCase().includes("no real order"));
});

test("EXIT_FILLED handles a missing netPnl gracefully (no 'NaN' in the message)", () => {
    const content = buildNotificationContent({ signal: { type: "EXIT_FILLED", price: 89, exitReason: "SIGNAL" }, runtime, strategyName: "X" });
    assert.ok(!content.body.includes("NaN"));
});

test("Every notification type includes the instrument symbol", () => {
    ["ENTRY_SIGNAL", "EXIT_SIGNAL", "ENTRY_FILLED", "EXIT_FILLED"].forEach((type) => {
        const content = buildNotificationContent({ signal: { type }, runtime, strategyName: "X" });
        assert.ok(content.title.includes("TESTSTOCK") || content.body.includes("TESTSTOCK"));
    });
});

test("Falls back to a generic strategy name when none is supplied", () => {
    const content = buildNotificationContent({ signal: { type: "ENTRY_SIGNAL" }, runtime });
    assert.ok(content.body.includes("Your strategy"));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
