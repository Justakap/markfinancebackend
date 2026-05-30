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

        conditions: [conditionSchema],

        entryConditions: [conditionSchema],

        exitConditions: [conditionSchema],

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
