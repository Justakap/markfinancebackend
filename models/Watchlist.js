const mongoose = require("mongoose");

const watchlistSchema = new mongoose.Schema(
    {
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            default: null,
        },

        name: {
            type: String,
            required: true,
        },

        stocks: [
            {
                symbol: String,
                name: String,
                longName: String,

                exchange: String,
                market: String,
                assetType: String,

                sector: String,
                industry: String,

                marketCap: Number,
                sharesOutstanding: Number,

                trailingPE: Number,
                forwardPE: Number,

                priceToBook: Number,
                bookValue: Number,

                epsTrailingTwelveMonths: Number,
                epsForward: Number,

                dividendYield: Number,
                dividendRate: Number,

                fiftyTwoWeekHigh: Number,
                fiftyTwoWeekLow: Number,

                averageAnalystRating: String,

                averageDailyVolume3Month: Number,
                averageDailyVolume10Day: Number,

                beta: Number,

                currency: String,

                website: String,

                updatedAt: Date,
                country: String,

                city: String,

                fullTimeEmployees: Number,

                longBusinessSummary: String,
            },
        ]
    },
    {
        timestamps: true,
    }
);

module.exports = mongoose.model("Watchlist", watchlistSchema);