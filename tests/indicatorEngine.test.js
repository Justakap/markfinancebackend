const assert = require("assert");

const {
    computeSeriesForCandles,
    alignRowsToPrimary,
    buildStrategyContextSeries,
} = require("../services/indicatorEngine");
const { indicatorKey } = require("../utils/indicatorRegistry");
const { evaluateProfessionalExpression, collectIndicatorRequirements } = require("../utils/strategyExpression");

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

function buildCandles(count, { startDay = 1, barsPerDay = count } = {}) {
    const candles = [];
    for (let i = 0; i < count; i += 1) {
        const day = startDay + Math.floor(i / barsPerDay);
        const minuteOfDay = 9 * 60 + 15 + (i % barsPerDay) * 5;
        const close = 100 + Math.sin(i / 3) * 4 + i * 0.1;
        candles.push({
            date: new Date(2024, 0, day, Math.floor(minuteOfDay / 60), minuteOfDay % 60).toISOString(),
            open: close - 0.3,
            high: close + 1,
            low: close - 1,
            close,
            volume: 1000 + i * 5,
        });
    }
    return candles;
}

console.log("Phase C — Indicator Engine + StrategyContext\n");

test("computeSeriesForCandles builds RSI/EMA/SMA series keyed correctly", () => {
    const candles = buildCandles(40);
    const requirements = [
        { name: "RSI", params: { period: 14 } },
        { name: "EMA", params: { period: 20 } },
        { name: "SMA", params: { period: 20 } },
    ];
    const series = computeSeriesForCandles(candles, requirements);

    assert.ok(Array.isArray(series[indicatorKey("RSI", { period: 14 })]));
    assert.ok(Array.isArray(series[indicatorKey("EMA", { period: 20 })]));
    assert.ok(Array.isArray(series[indicatorKey("SMA", { period: 20 })]));
    assert.strictEqual(series[indicatorKey("RSI", { period: 14 })].length, 40);
});

test("computeSeriesForCandles computes MACD once even when both MACD and MACD_SIGNAL are requested", () => {
    const candles = buildCandles(50);
    const requirements = [
        { name: "MACD", params: {} },
        { name: "MACD_SIGNAL", params: {} },
    ];
    const series = computeSeriesForCandles(candles, requirements);
    const macdSeries = series[indicatorKey("MACD", {})];
    const signalSeries = series[indicatorKey("MACD_SIGNAL", {})];

    assert.ok(Array.isArray(macdSeries));
    assert.ok(Array.isArray(signalSeries));
    assert.notDeepStrictEqual(macdSeries, signalSeries);
});

test("computeSeriesForCandles throws for an unregistered indicator (fail loud, never silent-false)", () => {
    assert.throws(() => computeSeriesForCandles(buildCandles(10), [{ name: "BOLLINGER", params: {} }]));
});

test("alignRowsToPrimary never selects a future auxiliary bar", () => {
    // Primary: 1-minute bars. Auxiliary: 5-minute bars starting at the same time.
    const primaryCandles = buildCandles(10, { barsPerDay: 10 }); // 9:15..9:24, 1 bar per index
    const auxiliaryCandles = [
        { date: new Date(2024, 0, 1, 9, 15).toISOString(), close: 1 },
        { date: new Date(2024, 0, 1, 9, 20).toISOString(), close: 2 },
    ];
    const auxiliaryRows = [{ tag: "bar@9:15" }, { tag: "bar@9:20" }];

    const aligned = alignRowsToPrimary(primaryCandles, auxiliaryCandles, auxiliaryRows);

    // Candles are 5 minutes apart in buildCandles's indexing here (barsPerDay
    // controls spacing via minuteOfDay += i*5), so primary index 0 (9:15)
    // aligns to aux bar@9:15, index 1 (9:20) aligns to aux bar@9:20, and
    // nothing after that ever regresses to an earlier/future bar.
    assert.deepStrictEqual(aligned[0], { tag: "bar@9:15" });
    assert.deepStrictEqual(aligned[1], { tag: "bar@9:20" });
    assert.deepStrictEqual(aligned[2], { tag: "bar@9:20" }, "no new aux bar yet -> keeps the last closed one, never a future one");
});

test("alignRowsToPrimary returns null for primary bars before any auxiliary bar has closed", () => {
    const primaryCandles = buildCandles(3, { barsPerDay: 3 });
    const auxiliaryCandles = [{ date: new Date(2024, 0, 1, 10, 0).toISOString(), close: 1 }];
    const auxiliaryRows = [{ tag: "late-bar" }];

    const aligned = alignRowsToPrimary(primaryCandles, auxiliaryCandles, auxiliaryRows);
    assert.strictEqual(aligned[0], null);
    assert.strictEqual(aligned[1], null);
});

test("buildStrategyContextSeries produces a context per primary bar, single timeframe", () => {
    const candles = buildCandles(30);
    const requirements = [{ name: "RSI", params: { period: 14 }, timeframe: "5m" }];
    const contexts = buildStrategyContextSeries({
        primaryTimeframe: "5m",
        candlesByTimeframe: { "5m": candles },
        requirements,
    });

    assert.strictEqual(contexts.length, 30);
    assert.ok(contexts[29]["5m"].indicators[indicatorKey("RSI", { period: 14 })] !== undefined);
});

test("buildStrategyContextSeries aligns an auxiliary timeframe's indicator onto primary bars", () => {
    const primaryCandles = buildCandles(20, { barsPerDay: 20 });
    // First 15m bar closes at 9:20 — strictly after the primary's first
    // bar (9:15) — so bar 0 has genuinely no aux bar yet, distinct from
    // the equal-timestamp case already covered above.
    const auxCandles = buildCandles(5, { barsPerDay: 5 }).map((c, i) => ({
        ...c,
        date: new Date(2024, 0, 1, 9, 20 + i * 20).toISOString(),
    }));

    const requirements = [
        { name: "RSI", params: { period: 2 }, timeframe: "5m" },
        { name: "EMA", params: { period: 2 }, timeframe: "15m" },
    ];

    const contexts = buildStrategyContextSeries({
        primaryTimeframe: "5m",
        candlesByTimeframe: { "5m": primaryCandles, "15m": auxCandles },
        requirements,
    });

    assert.strictEqual(contexts.length, 20);
    assert.ok(contexts[19]["15m"], "the 15m slot should be populated by bar 19 (well after the first 15m bar closed)");
    assert.strictEqual(contexts[0]["15m"], null, "bar 0 (9:15) is before the first 15m bar (9:20) closes");
});

test("End-to-end: a multi-timeframe strategy evaluates against a built context without throwing", () => {
    const primaryCandles = buildCandles(40, { barsPerDay: 40 });
    const auxCandles = buildCandles(10, { barsPerDay: 10 }).map((c, i) => ({
        ...c,
        date: new Date(2024, 0, 1, 9, 15 + i * 20).toISOString(),
    }));

    const tree = {
        type: "condition",
        left: { type: "indicator", name: "RSI", params: { period: 5 }, timeframe: "5m" },
        operator: "LT",
        right: { type: "indicator", name: "EMA", params: { period: 3 }, timeframe: "15m" },
    };

    const requirements = collectIndicatorRequirements(tree, [], "5m");
    const contexts = buildStrategyContextSeries({
        primaryTimeframe: "5m",
        candlesByTimeframe: { "5m": primaryCandles, "15m": auxCandles },
        requirements,
    });

    for (let i = 1; i < contexts.length; i += 1) {
        const result = evaluateProfessionalExpression(contexts[i], contexts[i - 1], tree, "5m");
        assert.strictEqual(typeof result, "boolean");
    }
});

// --- No-look-ahead structural test (explicit requirement from the
// professional-platform instructions): running the engine against a
// truncated series must never change an earlier signal. ---

test("No look-ahead: truncating the candle series doesn't change any earlier bar's indicator values", () => {
    const fullCandles = buildCandles(60);
    const truncated = fullCandles.slice(0, 45);

    const requirements = [
        { name: "RSI", params: { period: 14 } },
        { name: "EMA", params: { period: 20 } },
        { name: "MACD", params: {} },
        { name: "VWAP", params: {} },
    ];

    const fullSeries = computeSeriesForCandles(fullCandles, requirements);
    const truncatedSeries = computeSeriesForCandles(truncated, requirements);

    Object.keys(truncatedSeries).forEach((key) => {
        for (let i = 0; i < truncated.length; i += 1) {
            assert.strictEqual(
                truncatedSeries[key][i],
                fullSeries[key][i],
                `${key} at bar ${i} differs between full and truncated series — look-ahead leak`,
            );
        }
    });
});

test("No look-ahead: a full-vs-truncated strategy evaluation agrees on every bar they both cover", () => {
    const fullCandles = buildCandles(60);
    const truncated = fullCandles.slice(0, 45);

    const tree = {
        type: "condition",
        left: { type: "indicator", name: "RSI", params: { period: 14 } },
        operator: "LT",
        right: { type: "constant", value: 50 },
    };

    const fullContexts = buildStrategyContextSeries({
        primaryTimeframe: "5m",
        candlesByTimeframe: { "5m": fullCandles },
        requirements: [{ name: "RSI", params: { period: 14 }, timeframe: "5m" }],
    });
    const truncatedContexts = buildStrategyContextSeries({
        primaryTimeframe: "5m",
        candlesByTimeframe: { "5m": truncated },
        requirements: [{ name: "RSI", params: { period: 14 }, timeframe: "5m" }],
    });

    for (let i = 1; i < truncatedContexts.length; i += 1) {
        const fullResult = evaluateProfessionalExpression(fullContexts[i], fullContexts[i - 1], tree, "5m");
        const truncatedResult = evaluateProfessionalExpression(truncatedContexts[i], truncatedContexts[i - 1], tree, "5m");
        assert.strictEqual(truncatedResult, fullResult, `signal mismatch at bar ${i}`);
    }
});

console.log(`\n${passed} passed, ${failed} failed`);

if (failed > 0) {
    process.exit(1);
}
