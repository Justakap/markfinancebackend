const mongoose = require("mongoose");

/** Rejects malformed Mongo ObjectId route params with 400 before any DB query runs,
 *  so a bad id never falls through to a route's catch-all (which would otherwise
 *  turn a CastError into a misleading 500). Usage: validateObjectId("id") or
 *  validateObjectId("id", "watchlistId") for routes with more than one id param. */
function validateObjectId(...paramNames) {
    return (req, res, next) => {
        for (const paramName of paramNames) {
            const value = req.params[paramName];
            if (!mongoose.Types.ObjectId.isValid(value)) {
                return res.status(400).json({ message: "Invalid identifier" });
            }
        }
        return next();
    };
}

module.exports = { validateObjectId };
