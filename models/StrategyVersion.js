const mongoose = require("mongoose");

/**
 * Phase A — immutable strategy version (ADR-001: "StrategyVersion records
 * are immutable... historical backtests must always refer to the exact
 * strategy definition that produced them").
 *
 * `definition` holds the actual DSL document (Phase B's shape — GROUP/
 * CONDITION tree with structured indicator/price/constant operands, plus
 * universe/risk/execution config). It is intentionally `Mixed`: the DSL's
 * recursive shape is validated at the application layer
 * (strategyExpression.js's validateExpressionTree, extended in Phase B),
 * not via a recursive Mongoose schema.
 *
 * Immutability is enforced two ways: `immutable: true` on `definition`
 * blocks `.save()` from changing it after the first save, and — more
 * importantly, since `immutable` doesn't stop a raw `updateOne`/
 * `findOneAndUpdate` — by convention: no route in this codebase may ever
 * call an update operation against this collection. Only `create()`.
 * A new edit always means a new StrategyVersion document with
 * `versionNumber + 1`, never a mutation of an existing one.
 */
const strategyVersionSchema = new mongoose.Schema(
    {
        strategyId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "StrategyDefinition",
            required: true,
            index: true,
        },

        versionNumber: {
            type: Number,
            required: true,
            min: 1,
        },

        definition: {
            type: mongoose.Schema.Types.Mixed,
            required: true,
            immutable: true,
        },
    },
    {
        // No updatedAt — a version is never updated, only created.
        timestamps: { createdAt: true, updatedAt: false },
    },
);

strategyVersionSchema.index({ strategyId: 1, versionNumber: 1 }, { unique: true });

module.exports = mongoose.model("StrategyVersion", strategyVersionSchema);
