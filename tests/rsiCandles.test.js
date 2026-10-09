/**
 * Workstream J (Live Strategy Engine) — this file previously had no
 * dedicated unit coverage despite being the actual mechanism the codebase
 * already uses to decide "is this candle closed" (dropFormingCandle, used
 * by utils/backtestEngine.js's fetchCandleSeriesForBacktest). Bar-close
 * correctness is the #1 risk area for the live engine, so before building
 * anything on top of this function, its real behavior is verified here
 * directly — not assumed from its name or doc comment.
 */
const assert = require("assert");
const { dropFormingCandle, isBarForming, inferStepMs } = require("../utils/rsiCandles");

function candleOpenMs(candle) {
    return Date.parse(candle.timestamp);
}

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

function minuteCandle(isoTimestamp, close = 100) {
    return { timestamp: isoTimestamp, open: close, high: close, low: close, close, volume: 10 };
}

console.log("rsiCandles — candle-completion (bar-close) semantics\n");

test("inferStepMs derives the step from the gap between the last two candles (minutes)", () => {
    const candles = [minuteCandle("2024-01-02T09:15:00.000Z"), minuteCandle("2024-01-02T09:20:00.000Z")];
    // 5 minutes apart -> inferred step is 5 minutes, not the literal "1" unit param.
    assert.strictEqual(inferStepMs(candles, "minutes", "1"), 5 * 60 * 1000);
});

test("isBarForming is true when now is still inside the bar's own step window", () => {
    const openMs = Date.parse("2024-01-02T09:15:00.000Z");
    const stepMs = 60 * 1000;
    assert.strictEqual(isBarForming(openMs, stepMs, openMs + 30 * 1000), true);
});

test("isBarForming is false once a full step has elapsed since the bar's open", () => {
    const openMs = Date.parse("2024-01-02T09:15:00.000Z");
    const stepMs = 60 * 1000;
    assert.strictEqual(isBarForming(openMs, stepMs, openMs + 60 * 1000), false);
    assert.strictEqual(isBarForming(openMs, stepMs, openMs + 90 * 1000), false);
});

test("dropFormingCandle strips the last candle when it's still inside its own bar window", () => {
    const candles = [
        minuteCandle("2024-01-02T09:15:00.000Z"),
        minuteCandle("2024-01-02T09:16:00.000Z"),
        minuteCandle("2024-01-02T09:17:00.000Z"), // still forming "now"
    ];
    const nowMs = Date.parse("2024-01-02T09:17:30.000Z"); // 30s into the 09:17 bar
    const closed = dropFormingCandle(candles, "minutes", "1", nowMs);

    assert.strictEqual(closed.length, 2);
    assert.strictEqual(candleOpenMs(closed[closed.length - 1]), Date.parse("2024-01-02T09:16:00.000Z"));
});

test("dropFormingCandle keeps the last candle once its full bar duration has elapsed", () => {
    const candles = [
        minuteCandle("2024-01-02T09:15:00.000Z"),
        minuteCandle("2024-01-02T09:16:00.000Z"),
        minuteCandle("2024-01-02T09:17:00.000Z"),
    ];
    const nowMs = Date.parse("2024-01-02T09:18:00.000Z"); // exactly one full minute after 09:17's open
    const closed = dropFormingCandle(candles, "minutes", "1", nowMs);

    assert.strictEqual(closed.length, 3);
    assert.strictEqual(candleOpenMs(closed[closed.length - 1]), Date.parse("2024-01-02T09:17:00.000Z"));
});

test("dropFormingCandle never fabricates a bar — with only one candle it's returned as-is (nothing to compare steps against)", () => {
    const candles = [minuteCandle("2024-01-02T09:15:00.000Z")];
    const closed = dropFormingCandle(candles, "minutes", "1", Date.parse("2024-01-02T09:15:10.000Z"));
    assert.strictEqual(closed.length, 1);
});

test("dropFormingCandle with an empty array returns an empty array", () => {
    assert.deepStrictEqual(dropFormingCandle([], "minutes", "1", Date.now()), []);
});

test("dropFormingCandle on 1h candles uses the inferred hourly step, not a hardcoded minute step", () => {
    const candles = [minuteCandle("2024-01-02T09:00:00.000Z"), minuteCandle("2024-01-02T10:00:00.000Z")];
    const stillForming = dropFormingCandle(candles, "minutes", "60", Date.parse("2024-01-02T10:30:00.000Z"));
    assert.strictEqual(stillForming.length, 1);

    const closed = dropFormingCandle(candles, "minutes", "60", Date.parse("2024-01-02T11:00:00.000Z"));
    assert.strictEqual(closed.length, 2);
});

test("dropFormingCandle on daily candles uses a fixed 24h step regardless of market hours", () => {
    const candles = [minuteCandle("2024-01-01T00:00:00.000Z"), minuteCandle("2024-01-02T00:00:00.000Z")];
    // Only 6 hours after the 01-02 bar's midnight open — even though the
    // NSE session (09:15-15:30 IST) has already closed for that date, this
    // function's daily rule is wall-clock-24h-from-midnight, not
    // session-aware. Documented finding (LIVE_FEED_AUDIT-style note): this
    // is a conservative behavior (never marks a daily bar closed before
    // it genuinely could be), not a bug — verified here so the live engine
    // never assumes otherwise.
    const stillForming = dropFormingCandle(candles, "days", "1", Date.parse("2024-01-02T10:00:00.000Z"));
    assert.strictEqual(stillForming.length, 1);

    const closed = dropFormingCandle(candles, "days", "1", Date.parse("2024-01-03T00:00:00.000Z"));
    assert.strictEqual(closed.length, 2);
});

test("dropFormingCandle output is defensively cloned, not the same array/object references", () => {
    const candles = [minuteCandle("2024-01-02T09:15:00.000Z"), minuteCandle("2024-01-02T09:16:00.000Z")];
    const closed = dropFormingCandle(candles, "minutes", "1", Date.parse("2024-01-02T09:17:00.000Z"));
    assert.notStrictEqual(closed[0], candles[0]);
    assert.deepStrictEqual(closed[0], candles[0]);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
