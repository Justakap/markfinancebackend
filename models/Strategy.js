const mongoose = require("mongoose");

const conditionSchema = new mongoose.Schema(
    {
        indicator: {
            type: String,
            required: true,
        },

        operator: {
            type: String,
            required: true,
        },

        compareType: {
            type: String,
            enum: ["value", "indicator"],
            default: "value",
        },

        value: {
            type: String,
            required: true,
        },

        nextLogic: {
            type: String,
            enum: ["AND", "OR"],
            default: undefined,
        },
    },
    { _id: false }
);

const strategySchema = new mongoose.Schema(
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
            enum: ["ACTIVE", "INACTIVE"],
            default: "ACTIVE",
        },

        logic: {
            type: String,
            enum: ["AND", "OR"],
            default: "AND",
        },

        // Legacy flat-list format. Never migrated — still read directly by
        // strategyExpression.js's normalization layer for any strategy saved
        // before Phase 2.2 (or still created by older/sample-strategy paths).
        conditions: [conditionSchema],

        entryConditions: [conditionSchema],

        exitConditions: [conditionSchema],

        // Phase 2.2 nested expression tree (optional). When present, this
        // takes precedence over entryConditions/conditions above — see
        // strategyExpression.js's getEntryExpression()/getExitExpression().
        // Recursive {type:"group"|"condition", ...} shape; validated at the
        // application layer (validateExpressionTree) rather than via a
        // recursive Mongoose schema, which Mixed intentionally allows.
        entryExpression: {
            type: mongoose.Schema.Types.Mixed,
            default: undefined,
        },

        exitExpression: {
            type: mongoose.Schema.Types.Mixed,
            default: undefined,
        },

        stopLoss: {
            type: Number,
            default: 0,
        },

        target: {
            type: Number,
            default: 0,
        },

        alertEnabled: {
            type: Boolean,
            default: false,
        },
    },
    {
        timestamps: true,
    }
);

module.exports = mongoose.model("Strategy", strategySchema);
