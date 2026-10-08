const assert = require("assert");
const { CORPORATE_ACTIONS_NOTE } = require("../utils/backtestEngine");

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

console.log("Corporate-action disclosure (Phase 2.1C)\n");

test("CORPORATE_ACTIONS_NOTE is a non-empty string", () => {
    assert.strictEqual(typeof CORPORATE_ACTIONS_NOTE, "string");
    assert.ok(CORPORATE_ACTIONS_NOTE.length > 0);
});

test("CORPORATE_ACTIONS_NOTE mentions the specific unadjusted-data risks (splits, bonuses, dividends)", () => {
    const text = CORPORATE_ACTIONS_NOTE.toLowerCase();
    assert.ok(text.includes("split"), "expected the note to mention splits");
    assert.ok(text.includes("bonus"), "expected the note to mention bonuses");
    assert.ok(text.includes("dividend"), "expected the note to mention dividends");
});

test("CORPORATE_ACTIONS_NOTE does not falsely claim adjustment is reliable", () => {
    const text = CORPORATE_ACTIONS_NOTE.toLowerCase();
    assert.ok(
        text.includes("no correction") || text.includes("not") || text.includes("may not"),
        "expected the note to disclose the limitation, not assert correctness",
    );
});

console.log(`\n${passed} passed, ${failed} failed`);

if (failed > 0) {
    process.exit(1);
}
