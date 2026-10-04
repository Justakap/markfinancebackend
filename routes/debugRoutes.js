const express = require("express");

function createDebugRoutes({
    requireAuth,
    VALIDATION_MODE,
    upstoxMarketData,
    resolveInstrumentKey,
    runIndicatorValidation,
}) {
    const router = express.Router();

    // Debug/diagnostic endpoints — require auth and are only enabled when VALIDATION_MODE is on
    // (off by default in production unless ENABLE_VALIDATION_MODE=true). They must never be
    // reachable anonymously in production.
    router.get("/debug/:symbol", requireAuth, async (req, res) => {
        if (!VALIDATION_MODE) {
            return res.status(403).json({ message: "Debug endpoints disabled" });
        }

        try {
            const instrumentKey = await resolveInstrumentKey(req.params.symbol);
            if (!instrumentKey) {
                return res.status(404).json({ message: "Instrument not found on Upstox" });
            }

            const row = await upstoxMarketData
                .getRowsForWatchlist({
                    stocks: [
                        {
                            symbol: req.params.symbol,
                            instrumentKey,
                            name: req.params.symbol,
                        },
                    ],
                })
                .then((result) => result.data[0]);

            res.json({
                availableIndicators: {
                    Price: row?.price,
                    "Price Change %": row?.change,
                    Volume: row?.volume,
                    "PE Ratio": row?.pe,
                    "RSI (Daily)": row?.rsi,
                    "RSI (1 Hour)": row?.hourlyRsi,
                    "RSI (15 Minute)": row?.rsi15m,
                    "RSI (5 Minute)": row?.rsi5m,
                    EMA20: row?.ema20,
                },
                rawData: row,
                dataSource: "upstox",
            });
        } catch (error) {
            console.error("Debug endpoint error:", error);
            res.status(500).json({ message: "Failed to load debug data" });
        }
    });

    router.get("/validation/indicators", requireAuth, async (req, res) => {
        if (!VALIDATION_MODE) {
            return res.status(403).json({ message: "Validation mode disabled" });
        }

        try {
            const report = await runIndicatorValidation();
            res.json(report);
        } catch (error) {
            console.error("Validation indicators error:", error);
            res.status(500).json({ message: "Validation failed" });
        }
    });

    router.get("/validation/debug/:symbol", requireAuth, async (req, res) => {
        if (!VALIDATION_MODE) {
            return res.status(403).json({ message: "Validation mode disabled" });
        }

        try {
            const instrumentKey = await resolveInstrumentKey(req.params.symbol);
            const data = instrumentKey
                ? (
                      await upstoxMarketData.getRowsForWatchlist({
                          stocks: [
                              {
                                  symbol: req.params.symbol,
                                  instrumentKey,
                                  name: req.params.symbol,
                              },
                          ],
                      })
                  ).data[0]
                : null;
            res.json({ symbol: req.params.symbol, rawData: data, dataSource: "upstox" });
        } catch (error) {
            console.error("Validation debug error:", error);
            res.status(500).json({ message: "Validation failed" });
        }
    });

    return router;
}

module.exports = { createDebugRoutes };
