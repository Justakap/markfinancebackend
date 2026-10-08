const mongoose = require("mongoose");

/**
 * Phase A (professional Strategy Platform rebuild) — identity record only.
 * All actual strategy logic lives in immutable StrategyVersion documents
 * (see StrategyVersion.js / ADR-001 in .claude/state/DECISIONS.md).
 *
 * Deliberately named "StrategyDefinition" rather than reusing "Strategy" —
 * the legacy flat-condition `Strategy` model (models/Strategy.js) keeps its
 * own name and collection untouched. The two coexist; nothing here reads
 * from or writes to the legacy `strategies` collection. See ADR-006.
 */
const strategyDefinitionSchema = new mongoose.Schema(
    {
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
            index: true,
        },

        name: {
            type: String,
            required: true,
            trim: true,
        },

        description: {
            type: String,
            default: "",
        },

        status: {
            type: String,
            enum: ["ACTIVE", "ARCHIVED"],
            default: "ACTIVE",
        },

        // Points at the StrategyVersion currently considered "the strategy"
        // for editing/scanning purposes. Backtests never read this — they
        // reference a specific StrategyVersion id directly, frozen at run
        // time, so this pointer changing later cannot alter a past result.
        currentVersionId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "StrategyVersion",
            default: null,
        },
    },
    { timestamps: true },
);

strategyDefinitionSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model("StrategyDefinition", strategyDefinitionSchema);
