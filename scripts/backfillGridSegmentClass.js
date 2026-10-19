#!/usr/bin/env node
/**
 * One-time backfill (ADR-036 follow-up): recomputes `config.segmentClass`
 * for every existing GridSimulatorSession from its instrumentKey's real
 * instrument-master type, and updates it where it differs from what's
 * currently stored. Fixes pre-ADR-035 sessions (created before
 * segmentClass existed) that silently defaulted to "EQUITY_DELIVERY"
 * regardless of their actual instrument — e.g. an MCX commodity future
 * showing equity-delivery STT/brokerage/stamp-duty rates instead of its
 * correct CTT/₹20-capped-brokerage rates.
 *
 * DISPLAY-ONLY change: `config.segmentClass` only feeds
 * gridChargesCalculator.js's charges estimate. It is never read by the
 * crossing/accounting engine — cash, holdings, lots, realizedPnL, and
 * every trade already recorded are completely untouched by this script.
 *
 * Defaults to a DRY RUN (prints what would change, writes nothing).
 * Pass --apply to actually write the updates.
 *
 *   node scripts/backfillGridSegmentClass.js            # dry run
 *   node scripts/backfillGridSegmentClass.js --apply     # writes
 */
require("dotenv").config();

const { connectDatabase, disconnectDatabase } = require("../config/database");
const GridSimulatorSession = require("../models/GridSimulatorSession");
const marketDataService = require("../services/marketDataService");
const { classifySegmentClass } = require("../services/gridChargesCalculator");

async function main() {
    const apply = process.argv.includes("--apply");

    await connectDatabase();
    console.log("Loading Upstox instrument master (needed to classify each session's instrumentKey)...");
    await marketDataService.loadInstruments();

    const sessions = await GridSimulatorSession.find({}).select("instrumentKey symbol config.segmentClass");
    console.log(`Found ${sessions.length} grid simulator session(s) total.\n`);

    let changed = 0;
    let unresolvable = 0;

    for (const session of sessions) {
        const meta = marketDataService.getInstrumentMeta(session.instrumentKey);
        if (!meta) {
            unresolvable += 1;
            console.log(`  ? ${session.symbol} (${session._id}) — instrumentKey "${session.instrumentKey}" not found in the instrument master, skipped`);
            continue;
        }

        const current = session.config.segmentClass;
        const correct = classifySegmentClass(meta);

        if (current === correct) continue;

        changed += 1;
        console.log(`  ${apply ? "FIXED" : "WOULD FIX"}: ${session.symbol} (${session._id}) — ${current} -> ${correct}`);

        if (apply) {
            await GridSimulatorSession.updateOne({ _id: session._id }, { $set: { "config.segmentClass": correct } });
        }
    }

    console.log(`\n${changed} session(s) ${apply ? "updated" : "would be updated"}, ${unresolvable} unresolvable, ${sessions.length - changed - unresolvable} already correct.`);
    if (!apply && changed > 0) {
        console.log("\nThis was a DRY RUN — no writes were made. Re-run with --apply to write these changes.");
    }

    await disconnectDatabase();
}

main().catch((error) => {
    console.error("Backfill failed:", error);
    process.exit(1);
});
