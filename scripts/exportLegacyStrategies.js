#!/usr/bin/env node
/**
 * Read-only export of every legacy `Strategy` document and its related
 * `Backtest` history to a timestamped JSON file on disk.
 *
 * This is the first step of the legacy migration/reset mechanism
 * described in the architecture audit and ADR-005
 * (.claude/state/DECISIONS.md) — it exists so a full backup is always
 * available BEFORE any archival/reset of legacy strategies is ever
 * considered. It performs NO writes, NO deletes, and NO mutations against
 * MongoDB — it only reads and writes a local file.
 *
 * This script is intentionally NOT wired into app.js or any route (per
 * the project's hard rule: no destructive/reset logic in application
 * startup). It must be invoked manually:
 *
 *   node scripts/exportLegacyStrategies.js
 *
 * A future reset/archival script (not written yet — requires separate,
 * explicit user approval per ADR-005) should refuse to run unless a
 * recent export produced by this script exists.
 */
const path = require("path");
const fs = require("fs/promises");
require("dotenv").config();

const { connectDatabase, disconnectDatabase } = require("../config/database");
const Strategy = require("../models/Strategy");
const Backtest = require("../models/Backtest");

/** Pure, DB-free: groups backtests under their owning strategy and shapes
 *  the export payload. Separated from the I/O below so it's unit-testable
 *  without a live MongoDB connection. */
function buildExportPayload(strategies, backtests, { now = () => new Date() } = {}) {
    const backtestsByStrategy = new Map();
    backtests.forEach((bt) => {
        const key = String(bt.strategyId);
        if (!backtestsByStrategy.has(key)) backtestsByStrategy.set(key, []);
        backtestsByStrategy.get(key).push(bt);
    });

    return {
        exportedAt: now().toISOString(),
        schemaVersion: 1,
        strategyCount: strategies.length,
        backtestCount: backtests.length,
        strategies: strategies.map((strategy) => ({
            ...strategy,
            backtests: backtestsByStrategy.get(String(strategy._id)) || [],
        })),
    };
}

async function exportLegacyStrategies({ outDir = path.join(__dirname, "..", "exports") } = {}) {
    await connectDatabase();

    try {
        const strategies = await Strategy.find({}).lean();
        const strategyIds = strategies.map((s) => s._id);
        const backtests = await Backtest.find({ strategyId: { $in: strategyIds } }).lean();

        const payload = buildExportPayload(strategies, backtests);

        await fs.mkdir(outDir, { recursive: true });
        const filename = `legacy-strategies-${payload.exportedAt.replace(/[:.]/g, "-")}.json`;
        const filePath = path.join(outDir, filename);
        await fs.writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");

        console.log(
            `Exported ${payload.strategyCount} strategies and ${payload.backtestCount} backtests to ${filePath}`,
        );

        return filePath;
    } finally {
        await disconnectDatabase();
    }
}

if (require.main === module) {
    exportLegacyStrategies().catch((error) => {
        console.error("Export failed:", error.message);
        process.exitCode = 1;
    });
}

module.exports = { exportLegacyStrategies, buildExportPayload };
