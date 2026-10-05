/**
 * Serializes Upstox REST calls to avoid burst 429s, and retries transient
 * failures (429 rate-limit, 502/503/504, network/timeout) with exponential
 * backoff + jitter, honoring Retry-After when Upstox sends it.
 *
 * Permanent 4xx errors (400 bad request, 401/403 auth, 404 not found, etc.)
 * are never retried — they bubble up immediately so callers (e.g.
 * instrumentKeyResolver's invalid-key cache) can react to them.
 *
 * Priority lanes: calls queued with `{ priority: "critical" }` (live LTP
 * lookups that block a user-facing response) always run before queued
 * `"background"` calls (candle fetches, PE lookups feeding indicators),
 * so a burst of background work never makes a critical lookup wait behind
 * it. Both lanes share the same MIN_GAP_MS throttle clock below, so the
 * combined Upstox request rate is governed exactly as before — splitting
 * only changes queue *ordering*, not how fast requests go out overall.
 */
const { recordUpstoxApiCall } = require("./metrics");

const criticalQueue = [];
const backgroundQueue = [];
let pumping = false;
let lastRequestAt = 0;

const MIN_GAP_MS = Number(process.env.UPSTOX_REQUEST_GAP_MS || 50);
const MAX_RETRIES = Number(process.env.UPSTOX_MAX_RETRIES || 3);
const BASE_BACKOFF_MS = Number(process.env.UPSTOX_RETRY_BASE_MS || 500);
const MAX_BACKOFF_MS = Number(process.env.UPSTOX_RETRY_MAX_MS || 8000);

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRetryAfterMs(error) {
    const header = error?.response?.headers?.["retry-after"];
    if (!header) return null;

    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

    const dateMs = Date.parse(header);
    return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : null;
}

function isRetryableError(error) {
    const status = error?.response?.status;
    if (status) {
        return status === 429 || status === 502 || status === 503 || status === 504;
    }
    // No HTTP response at all (timeout/ECONNABORTED/network error) — transient, worth a retry.
    return Boolean(error?.request) || error?.code === "ECONNABORTED";
}

async function runThrottled(task) {
    const elapsed = Date.now() - lastRequestAt;
    const wait = Math.max(0, MIN_GAP_MS - elapsed);
    if (wait > 0) {
        await sleep(wait);
    }
    lastRequestAt = Date.now();
    recordUpstoxApiCall();
    return task();
}

async function runWithRetry(task, maxRetries) {
    let attempt = 0;

    while (true) {
        try {
            return await runThrottled(task);
        } catch (error) {
            if (!isRetryableError(error) || attempt >= maxRetries) {
                throw error;
            }

            attempt += 1;
            const status = error?.response?.status;
            const retryAfterMs = getRetryAfterMs(error);
            const backoff =
                retryAfterMs ?? Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (attempt - 1));
            const jitter = Math.random() * 0.3 * backoff;
            const delay = Math.round(backoff + jitter);

            console.log(
                `Upstox request ${status ? `${status} ` : ""}retry ${attempt}/${maxRetries} in ${delay}ms`,
            );

            await sleep(delay);
        }
    }
}

/**
 * Picks the next queued item to run: any pending critical-lane item always
 * wins over background-lane ones, FIFO within a lane. This is what lets a
 * live-price lookup jump ahead of a large backlog of candle fetches without
 * needing a second, independently-paced queue (which would risk the two
 * lanes together exceeding Upstox's rate limit).
 */
async function pump() {
    if (pumping) return;
    pumping = true;

    try {
        while (criticalQueue.length > 0 || backgroundQueue.length > 0) {
            const item = criticalQueue.length > 0 ? criticalQueue.shift() : backgroundQueue.shift();

            try {
                const result = await runWithRetry(item.task, item.maxRetries);
                item.resolve(result);
            } catch (error) {
                item.reject(error);
            }
        }
    } finally {
        pumping = false;
    }
}

/**
 * `task` is a zero-arg function returning a promise (e.g. an axios call).
 * `options.priority`: `"critical"` jumps ahead of queued `"background"`
 * (default) work; it does not interrupt a task already in flight.
 */
function enqueue(task, options = {}) {
    const maxRetries = Number.isFinite(options.maxRetries) ? options.maxRetries : MAX_RETRIES;
    const queue = options.priority === "critical" ? criticalQueue : backgroundQueue;

    return new Promise((resolve, reject) => {
        queue.push({ task, maxRetries, resolve, reject });
        pump();
    });
}

module.exports = { enqueue, isRetryableError, getRetryAfterMs };
