/**
 * Throttles and retries Upstox REST calls to avoid burst 429s. Retries
 * transient failures (429 rate-limit, 502/503/504, network/timeout) with
 * exponential backoff + jitter, honoring Retry-After when Upstox sends it.
 *
 * Permanent 4xx errors (400 bad request, 401/403 auth, 404 not found, etc.)
 * are never retried — they bubble up immediately so callers (e.g.
 * instrumentKeyResolver's invalid-key cache) can react to them.
 *
 * Priority lanes (highest first): `"critical"` (live LTP lookups that block
 * a user-facing response) > `"background"` (default — candle fetches, and
 * any on-demand PE lookup needed to fulfill a direct request) > `"low"`
 * (fire-and-forget PE warming only). A lane only runs once every queued
 * item ahead of it is gone, and it never interrupts a task already in
 * flight. This guarantees indicator candle requests (background) always
 * get a turn before PE warming (low) without starving PE indefinitely —
 * `low` still gets dispatched as soon as the busier lanes drain, which they
 * do between refresh bursts (candle/LTP work is bounded per watchlist, not
 * a continuous stream).
 *
 * Concurrency: up to `UPSTOX_QUEUE_CONCURRENCY` calls may be in flight at
 * once (default 3, chosen conservatively — see CLAUDE.md's change history
 * for the measured comparison against 5, which showed no benefit for a
 * typical watchlist size), instead of waiting for each call's full round
 * trip to finish before starting the next. This does NOT raise the actual
 * request rate ceiling — every real network call (across every concurrent
 * slot) still goes through `reserveSlot()`, which enforces at least
 * MIN_GAP_MS between successive call *starts*, globally, exactly as before.
 * Previously that ceiling (1 request / MIN_GAP_MS, e.g. 20/s at the 50ms
 * default) was never actually reached — effective throughput was capped by
 * each call's network latency instead, since the queue waited for one call
 * to fully complete before starting the next. Concurrency removes that
 * artificial cap without changing how many requests/sec Upstox actually
 * sees — though unlike before (where true network concurrency was always
 * exactly 1), it does mean up to MAX_CONCURRENCY requests can be
 * simultaneously open, which is why this is deliberately conservative
 * rather than raised further without evidence of a need.
 */
const { recordUpstoxApiCall } = require("./metrics");

const criticalQueue = [];
const backgroundQueue = [];
const lowQueue = [];
const slotWaiters = [];
let pumping = false;
let activeCount = 0;
let lastRequestAt = 0;

const MIN_GAP_MS = Number(process.env.UPSTOX_REQUEST_GAP_MS || 50);
const MAX_RETRIES = Number(process.env.UPSTOX_MAX_RETRIES || 3);
const BASE_BACKOFF_MS = Number(process.env.UPSTOX_RETRY_BASE_MS || 500);
const MAX_BACKOFF_MS = Number(process.env.UPSTOX_RETRY_MAX_MS || 8000);
const MAX_CONCURRENCY = Math.max(1, Number(process.env.UPSTOX_QUEUE_CONCURRENCY || 3));

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

/**
 * Reserves the next allowed call-start time and advances `lastRequestAt` in
 * the same synchronous step (no `await` in between), so concurrent callers
 * each get a distinct, correctly-spaced slot instead of racing to read
 * `lastRequestAt` before any of them has updated it.
 */
function reserveSlot() {
    const now = Date.now();
    const slot = Math.max(now, lastRequestAt + MIN_GAP_MS);
    lastRequestAt = slot;
    return slot;
}

async function runThrottled(task) {
    const slot = reserveSlot();
    const wait = slot - Date.now();
    if (wait > 0) {
        await sleep(wait);
    }
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

function releaseSlot() {
    activeCount -= 1;
    const resolveWaiter = slotWaiters.shift();
    if (resolveWaiter) resolveWaiter();
}

function nextQueuedItem() {
    if (criticalQueue.length > 0) return criticalQueue.shift();
    if (backgroundQueue.length > 0) return backgroundQueue.shift();
    return lowQueue.shift();
}

function hasQueuedWork() {
    return criticalQueue.length > 0 || backgroundQueue.length > 0 || lowQueue.length > 0;
}

/**
 * Picks the next queued item to run: critical > background > low, FIFO
 * within a lane; a lane is only considered once every busier lane is
 * empty. Dispatches up to MAX_CONCURRENCY items at once (not awaited to
 * completion here) — each dispatched item still goes through
 * `runThrottled`'s shared slot reservation, so the actual Upstox request
 * rate is unchanged.
 */
async function pump() {
    if (pumping) return;
    pumping = true;

    try {
        while (hasQueuedWork()) {
            if (activeCount >= MAX_CONCURRENCY) {
                await new Promise((resolve) => slotWaiters.push(resolve));
                continue;
            }

            const item = nextQueuedItem();
            activeCount += 1;

            runWithRetry(item.task, item.maxRetries).then(item.resolve, item.reject).finally(releaseSlot);
        }
    } finally {
        pumping = false;
    }
}

/**
 * `task` is a zero-arg function returning a promise (e.g. an axios call).
 * `options.priority`: `"critical"` jumps ahead of queued `"background"`
 * (default) work; `"low"` only runs once both of those lanes are empty.
 * None of these interrupt a task already in flight.
 */
function enqueue(task, options = {}) {
    const maxRetries = Number.isFinite(options.maxRetries) ? options.maxRetries : MAX_RETRIES;
    const queue =
        options.priority === "critical"
            ? criticalQueue
            : options.priority === "low"
              ? lowQueue
              : backgroundQueue;

    return new Promise((resolve, reject) => {
        queue.push({ task, maxRetries, resolve, reject });
        pump();
    });
}

module.exports = { enqueue, isRetryableError, getRetryAfterMs };
