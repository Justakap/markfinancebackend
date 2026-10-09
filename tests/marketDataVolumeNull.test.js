/**
 * Verification-pass audit (2026-10-09) — a concrete, confirmed defect:
 * buildRow()/buildQuickRow() in services/marketDataService.js previously
 * coerced a genuinely-missing `volume` to `0` via `volume ?? 0`/
 * `live.volume ?? 0`, indistinguishable from a real zero-volume day — the
 * exact "null coerced to zero" bug class the frontend's CLAUDE.md change
 * history already documents fixing (toFiniteNumber()), just not applied
 * to this backend field. Fixed by removing the `?? 0` fallback so a
 * genuinely-missing volume stays `null`, matching every other field in
 * the same row (ltp/vwap/oi/etc.).
 *
 * No network/DB access needed: buildRow's PE lookup is opt-in
 * (options.includePe, default false) and its cached-bundle read is an
 * in-memory Map lookup (returns null when nothing is cached, never a
 * fetch); buildQuickRow touches only in-memory Maps.
 */
const assert = require("assert");

process.env.UPSTOX_INSTRUMENT_MASTER_URL = "https://fake.test/market-data-volume-null-instruments.json";
process.env.UPSTOX_ACCESS_TOKEN = "fake-token-for-tests";

const marketDataService = require("../services/marketDataService");
const { buildRow, buildQuickRow, liveData, isValidInstrumentKey } = marketDataService;

let passed = 0;
let failed = 0;

async function test(name, fn) {
    try {
        await fn();
        passed += 1;
        console.log(`  ✓ ${name}`);
    } catch (error) {
        failed += 1;
        console.error(`  ✗ ${name}`);
        console.error(`    ${error.stack || error.message}`);
    }
}

console.log("Verification pass — marketDataService volume null-vs-zero\n");

(async () => {
    await test("buildRow: a genuinely-missing volume stays null, never fabricated as 0", async () => {
        const key = "NSE_EQ|VOLNULLTEST";
        liveData.delete(key);
        // isValidInstrumentKey requires instrumentMeta to know this key —
        // without it, buildRow takes its early "unsupported instrument"
        // branch instead of the main row-building path we want to exercise.
        // We can't populate the real instrumentMeta map (not exported,
        // populated only via loadInstruments()), so instead we confirm the
        // early-return branch ALSO never fabricates volume, which is the
        // other code path real unknown-instrument rows take.
        assert.strictEqual(isValidInstrumentKey(key), false);
        const row = await buildRow({ instrumentKey: key, symbol: "VOLNULLTEST" });
        assert.strictEqual(row.volume, null, "unsupported-instrument branch must not fabricate volume as 0 either");
    });

    await test("buildQuickRow: live.volume absent stays null, never 0", () => {
        const key = "NSE_EQ|VOLNULLTEST2";
        liveData.delete(key); // no live tick at all for this instrument
        const row = buildQuickRow({ instrumentKey: key, symbol: "VOLNULLTEST2" });
        assert.strictEqual(row.volume, null);
    });

    await test("buildQuickRow: a real live volume of 0 is still distinguishable from missing (both currently render as 0, documented)", () => {
        const key = "NSE_EQ|VOLNULLTEST3";
        liveData.set(key, { ltp: 100, volume: 0 });
        const row = buildQuickRow({ instrumentKey: key, symbol: "VOLNULLTEST3" });
        // `0 ?? null` is 0, not null — a real zero is correctly preserved
        // as 0 (not the bug: the bug was MISSING data becoming 0, not a
        // real 0 becoming something else).
        assert.strictEqual(row.volume, 0);
        liveData.delete(key);
    });

    await test("buildQuickRow: a genuine positive live volume passes through unchanged", () => {
        const key = "NSE_EQ|VOLNULLTEST4";
        liveData.set(key, { ltp: 100, volume: 48213 });
        const row = buildQuickRow({ instrumentKey: key, symbol: "VOLNULLTEST4" });
        assert.strictEqual(row.volume, 48213);
        liveData.delete(key);
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
