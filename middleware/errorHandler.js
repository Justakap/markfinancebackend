/** Centralized error handling — never leak stack traces, Mongo internals or file paths to clients. */

function notFoundHandler(req, res) {
    res.status(404).json({ message: "Not found" });
}

function errorHandler(err, req, res, next) {
    if (res.headersSent) {
        return next(err);
    }

    console.error(`[${req.method} ${req.originalUrl}]`, err);

    if (err?.name === "CastError") {
        return res.status(400).json({ message: "Invalid identifier" });
    }

    if (err?.name === "ValidationError") {
        return res.status(400).json({ message: "Invalid request data" });
    }

    if (err?.message === "Not allowed by CORS") {
        return res.status(403).json({ message: "Origin not allowed" });
    }

    const status = Number.isInteger(err?.statusCode) ? err.statusCode : 500;
    const message = status < 500 && err?.clientMessage ? err.clientMessage : "Internal server error";

    res.status(status).json({ message });
}

module.exports = { notFoundHandler, errorHandler };
