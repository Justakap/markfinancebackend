#!/usr/bin/env node
/**
 * One-time backfill (ADR-037): synthesizes `state.pendingBuyLevels`/
 * `state.pendingSellLevels` for every existing GridSimulatorSession that
 * predates the per-fill paired-trigger redesign (ADR-037, which replaces
 * the single `state.activeReference` rebasing anchor).
 *
 * `gridSimulatorService.js`'s `docStateToPlain()` already does this same
 * synthesis LAZILY, in memory, every time such a session is read — so an
 * un-migrated session keeps working correctly even before this script
 * runs. This script exists to make the migration explicit, auditable, and
 * persisted (so the stored document itself reflects the real values,
 * rather than only ever being recomputed on the fly) — same precedent as
 * scripts/backfillGridSegmentClass.js.
 *
 * Synthesis formula (necessarily a one-time approximation — the old model
 * has no concept of "one trigger per past fill," so this picks a sensible
 * continuation point rather than perfectly reconstructing history):
 *   pendingBuyLevels:  [activeReference - buyVariance]
 *   pendingSellLevels: holdings > 0 ? [activeReference + sellVariance] : []
 *
 * DISPLAY/TRIGGER-ONLY change: cash, holdings, lots, avgCost, and
 * realizedPnL are completely untouched — this only affects which price
 * triggers the NEXT buy/sell, never anything already recorded.
 *
 * Defaults to a DRY RUN (prints what would change, writes nothing).
 * Pass --apply to actually write the updates.
 *
 *   node scripts/backfillGridPendingLevels.js            # dry run
 *   node scripts/backfillGridPendingLevels.js --apply     # writes
 */
require("dotenv").config();

const { connectDatabase, disconnectDatabase } = require("../config/database");
const GridSimulatorSession = require("../models/GridSimulatorSession");
const { roundPrice } = require("../services/gridSimulatorEngine");

async function main() {
    const apply = process.argv.includes("--apply");

    await connectDatabase();

    const sessions = await GridSimulatorSession.find({}).select("symbol config state.activeReference state.pendingBuyLevels state.holdings");
    console.log(`Found ${sessions.length} grid simulator session(s) total.\n`);

    let changed = 0;

    for (const session of sessions) {
        const alreadyMigrated = Array.isArray(session.state.pendingBuyLevels) && session.state.pendingBuyLevels.length > 0;
        if (alreadyMigrated) continue;

        const legacyReference = session.state.activeReference ?? session.config.referencePrice;
        const buyVariance = session.config.gridInterval;
        const sellVariance = session.config.sellVariance ?? session.config.gridInterval;

        const pendingBuyLevels = [roundPrice(legacyReference - buyVariance)];
        const pendingSellLevels = session.state.holdings > 0 ? [roundPrice(legacyReference + sellVariance)] : [];

        changed += 1;
        console.log(
            `  ${apply ? "FIXED" : "WOULD FIX"}: ${session.symbol} (${session._id}) — pendingBuyLevels=${JSON.stringify(pendingBuyLevels)}, pendingSellLevels=${JSON.stringify(pendingSellLevels)}`,
        );

        if (apply) {
            await GridSimulatorSession.updateOne(
                { _id: session._id },
                { $set: { "state.pendingBuyLevels": pendingBuyLevels, "state.pendingSellLevels": pendingSellLevels } },
            );
        }
    }

    console.log(`\n${changed} session(s) ${apply ? "updated" : "would be updated"}, ${sessions.length - changed} already migrated.`);
    if (!apply && changed > 0) {
        console.log("\nThis was a DRY RUN — no writes were made. Re-run with --apply to write these changes.");
    }

    await disconnectDatabase();
}

main().catch((error) => {
    console.error("Backfill failed:", error);
    process.exit(1);
});
