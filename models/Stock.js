const mongoose = require("mongoose");

const stockSchema = new mongoose.Schema(
    {
        symbol: {
            type: String,
            required: true
        },

        name: {
            type: String,
            required: true
        },

        exchange: {
            type: String,
            default: "NSE"
        }
    },
    {
        timestamps: true
    }
);

module.exports = mongoose.model("Stock", stockSchema);