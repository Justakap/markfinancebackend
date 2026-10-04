// Production frontend origin for this project (see backend/.env.example to override via ALLOWED_ORIGINS/FRONTEND_URL).
const DEFAULT_PRODUCTION_ORIGIN = "https://markfinance.netlify.app";

const DEV_ORIGINS = [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:3001",
    "http://127.0.0.1:3001",
];

function getAllowedOrigins() {
    const fromEnv = `${process.env.ALLOWED_ORIGINS || process.env.FRONTEND_URL || ""}`
        .split(",")
        .map((origin) => origin.trim().replace(/\/$/, ""))
        .filter(Boolean);

    const origins = new Set(fromEnv.length ? fromEnv : [DEFAULT_PRODUCTION_ORIGIN]);

    if (process.env.NODE_ENV !== "production") {
        DEV_ORIGINS.forEach((origin) => origins.add(origin));
    }

    return [...origins];
}

/** No Origin header (server-to-server, curl, same-origin) is allowed through;
 *  any browser Origin must be in the allowlist — no implicit wildcard fallback. */
function isOriginAllowed(origin) {
    if (!origin) return true;
    return getAllowedOrigins().includes(origin.replace(/\/$/, ""));
}

module.exports = { getAllowedOrigins, isOriginAllowed };
