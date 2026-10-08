const express = require("express");

/** Maps an Upstox/axios error to a safe client-facing status + message.
 *  Upstox 401/403 means OUR server's Upstox credential is bad — it must
 *  never be surfaced as a 401/403 to the browser, since the frontend's
 *  global 401 interceptor (handleUnauthorized()) would wrongly clear the
 *  user's own session and log them out for an unrelated upstream problem. */
function mapUpstreamError(error) {
    const status = error?.response?.status;

    if (status === 429) {
        return { status: 429, message: "Too many option-chain requests right now. Wait a moment and retry." };
    }

    if (status === 401 || status === 403) {
        return { status: 503, message: "Option chain data is temporarily unavailable. Please try again shortly." };
    }

    if (status >= 500 || !status) {
        return { status: 503, message: "Option chain data is temporarily unavailable. Please try again shortly." };
    }

    return { status: 502, message: "Failed to load option chain data." };
}

function createOptionChainRoutes({
    requireAuth,
    optionChainLimiter,
    upstoxMarketData,
    getOptionChain,
    getOptionExpiries,
    isValidExpiryFormat,
}) {
    const router = express.Router();

    router.get("/option-chain", requireAuth, optionChainLimiter, async (req, res) => {
        try {
            const instrumentKey = String(req.query.instrumentKey || "").trim();
            const expiry = String(req.query.expiry || "").trim();

            if (!instrumentKey) {
                return res.status(400).json({ message: "instrumentKey is required" });
            }

            if (!upstoxMarketData.isValidInstrumentKey(instrumentKey)) {
                return res.status(400).json({ message: "Invalid instrumentKey" });
            }

            if (!expiry) {
                return res.status(400).json({ message: "expiry is required" });
            }

            if (!isValidExpiryFormat(expiry)) {
                return res.status(400).json({ message: "expiry must be in YYYY-MM-DD format" });
            }

            const chain = await getOptionChain(instrumentKey, expiry);
            return res.json(chain);
        } catch (error) {
            const { status, message } = mapUpstreamError(error);
            console.error("Option chain error:", error.message);
            return res.status(status).json({ message });
        }
    });

    router.get("/option-chain/expiries", requireAuth, optionChainLimiter, async (req, res) => {
        try {
            const instrumentKey = String(req.query.instrumentKey || "").trim();

            if (!instrumentKey) {
                return res.status(400).json({ message: "instrumentKey is required" });
            }

            if (!upstoxMarketData.isValidInstrumentKey(instrumentKey)) {
                return res.status(400).json({ message: "Invalid instrumentKey" });
            }

            const expiries = await getOptionExpiries(instrumentKey);
            return res.json({ instrumentKey, expiries });
        } catch (error) {
            const { status, message } = mapUpstreamError(error);
            console.error("Option expiries error:", error.message);
            return res.status(status).json({ message });
        }
    });

    return router;
}

module.exports = { createOptionChainRoutes, mapUpstreamError };
