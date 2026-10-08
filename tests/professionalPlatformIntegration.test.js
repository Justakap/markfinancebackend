/**
 * End-to-end integration test for the A→F milestone: a strategy definition
 * (A/B) runs through the indicator engine (C), the execution engine (D/E),
 * and analytics (F), and the result is shaped into documents that
 * genuinely validate against Phase A's Mongoose schemas — no live DB
 * connection needed (schema validation runs in-memory).
 */
const assert = require("assert");
const mongoose = require("mongoose");

const { validateStrategyDefinition, collectIndicatorRequirements, getProfessionalWarmupBars } = require("../utils/strategyExpression");
const { buildStrategyContextSeries } = require("../services/indicatorEngine");
const { runProfessionalBacktest } = require("../services/backtestExecutionEngine");
const { computeBacktestSummary } = require("../services/backtestAnalyticsService");
const StrategyVersion = require("../models/StrategyVersion");
const BacktestResult = require("../models/BacktestResult");
const BacktestTrade = require("../models/BacktestTrade");

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

function buildCandles(count) {
    const candles = [];
    for (let i = 0; i < count; i += 1) {
        const close = 100 + Math.sin(i / 5) * 10 + i * 0.1;
        candles.push({
            date: new Date(2024, 0, 1 + i).toISOString(),
            open: close - 0.4,
            high: close + 1.5,
            low: close - 1.5,
            close,
            volume: 1000 + i * 2,
        });
    }
    return candles;
}

console.log("A→F integration — strategy definition through analytics, schema-validated\n");

test("A full strategy definition validates, runs, and its output fits the Phase A schemas", () => {
    const definition = {
        version: 2,
        name: "Integration Test Strategy",
        universe: { timeframe: "1d" },
        entry: {
            type: "condition",
            left: { type: "indicator", name: "RSI", params: { period: 14 } },
            operator: "LT",
            right: { type: "constant", value: 35 },
        },
        exit: {
            type: "condition",
            left: { type: "indicator", name: "RSI", params: { period: 14 } },
            operator: "GT",
            right: { type: "constant", value: 65 },
        },
        risk: {
            stopLoss: { type: "percent", value: 6 },
            takeProfit: { type: "percent", value: 10 },
        },
        execution: {
            side: "LONG",
            positionSizing: { type: "percentOfEquity", value: 100 },
        },
    };

    // B: validate
    assert.doesNotThrow(() => validateStrategyDefinition(definition));

    // A: shape into a StrategyVersion and confirm it validates against the
    // real Mongoose schema (immutable field, required fields) in-memory.
    const strategyId = new mongoose.Types.ObjectId();
    const versionDoc = new StrategyVersion({ strategyId, versionNumber: 1, definition });
    assert.strictEqual(versionDoc.validateSync(), undefined);

    // C: build the indicator context
    const candles = buildCandles(120);
    const entryReqs = collectIndicatorRequirements(definition.entry, [], "1d");
    const exitReqs = collectIndicatorRequirements(definition.exit, [], "1d");
    const requirements = [...entryReqs, ...exitReqs];
    const contexts = buildStrategyContextSeries({
        primaryTimeframe: "1d",
        candlesByTimeframe: { "1d": candles },
        requirements,
    });
    const startIndex = Math.max(
        getProfessionalWarmupBars(definition.entry, "1d"),
        getProfessionalWarmupBars(definition.exit, "1d"),
    );

    // D/E: run the engine
    const engineResult = runProfessionalBacktest({
        strategy: { entryExpression: definition.entry, exitExpression: definition.exit, risk: definition.risk, execution: definition.execution },
        candles,
        contexts,
        startIndex,
        primaryTimeframe: "1d",
        initialCapital: 10000,
        commissionPct: 0.03,
        slippagePct: 0.05,
    });

    // F: analytics
    const summary = computeBacktestSummary({
        trades: engineResult.trades,
        equitySeries: engineResult.equitySeries,
        initialCapital: 10000,
        timeframe: "1d",
    });

    assert.ok(Number.isFinite(summary.totalReturnPct));
    assert.ok(Number.isFinite(summary.finalEquity));

    // Shape + validate a BacktestResult document (no embedded trades/full
    // equity array of sub-documents — compact parallel arrays only, per
    // ADR on document size).
    const userId = new mongoose.Types.ObjectId();
    const resultDoc = new BacktestResult({
        userId,
        strategyVersionId: versionDoc._id,
        instrumentKey: "NSE_EQ|TEST0001",
        symbol: "TESTSTOCK",
        timeframe: "1d",
        dateRange: { from: new Date(candles[startIndex].date), to: new Date(candles[candles.length - 1].date) },
        initialCapital: 10000,
        executionConfig: { fillRule: "next-bar-open", slTpAmbiguityPolicy: "stop-wins" },
        costConfig: { commissionPct: 0.03, slippagePct: 0.05 },
        summary,
        equitySeries: engineResult.equitySeries,
        tradeCount: engineResult.trades.length,
    });
    assert.strictEqual(resultDoc.validateSync(), undefined);

    // Shape + validate each BacktestTrade document.
    engineResult.trades.forEach((trade) => {
        const tradeDoc = new BacktestTrade({ backtestResultId: resultDoc._id, ...trade });
        const error = tradeDoc.validateSync();
        assert.strictEqual(error, undefined, error ? JSON.stringify(error.errors) : undefined);
    });
});

console.log(`\n${passed} passed, ${failed} failed`);

if (failed > 0) {
    process.exit(1);
}
