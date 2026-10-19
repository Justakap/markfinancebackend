const axios = require("axios");
const { enqueue } = require("../utils/upstoxRequestQueue");
const {
    isInstrumentKeyBlocked,
    isInvalidInstrumentMessage,
    markInstrumentKeyInvalid,
    canFetchCandles,
} = require("../utils/instrumentKeyResolver");

const { dedupe } = require("../utils/requestDedup");
const { createBoundedCache } = require("../utils/boundedCache");

/**
 * Caches the through-yesterday historical portion of intraday candle
 * requests — originally scoped to "minutes" only (minute1/5/15), now also
 * covers "hours" (and any chunked sub-range the longer-history backtest
 * path below splits a request into, see `fetchHistoricalCandlesChunked`).
 * The historical-range endpoint never returns today's data (verified
 * directly against the live API), so once a trading day has closed, that
 * portion cannot change again until the next one does — making it safe to
 * cache across the 15-30s refresh cadence that previously re-fetched it
 * unchanged every time, AND safe to cache indefinitely per exact chunk
 * once that chunk's own `toDate` is in the past (a closed historical
 * window never changes).
 *
 * Cache key includes the exact requested date range (`fromDate`/`toDate`),
 * which is itself derived from "today's date" for the un-chunked case — so
 * the key naturally changes at each calendar-day rollover (including
 * non-trading days; a weekend/holiday costs at most one harmless re-fetch
 * of identical data, not a correctness issue). For a chunked historical
 * sub-range (e.g. "2024-01-01..2024-01-29"), the key never changes at all
 * once set, since that exact window is fixed/closed forever — this is what
 * makes a 365-day 5m/1h backtest re-run cheaply reuse every chunk it
 * already fetched instead of re-downloading the whole year. `ttlMs` is a
 * backstop, not the primary invalidation mechanism. Only non-empty results
 * are cached, so a transient failure is never remembered as if it were a
 * genuine answer.
 *
 * Env var names kept as-is (`UPSTOX_HISTORICAL_CANDLE_*`) for backward
 * compatibility with any already-configured deployment, even though the
 * cache's scope has grown beyond "minute" candles.
 */
const historicalRangeCandleCache = createBoundedCache({
    maxSize: Number(process.env.UPSTOX_HISTORICAL_CANDLE_CACHE_MAX_SIZE || 300),
    ttlMs: Number(process.env.UPSTOX_HISTORICAL_CANDLE_TTL_MS || 26 * 60 * 60 * 1000),
});

/**
 * Upstox v3 historical-candle API — verified provider-imposed maximum span
 * per SINGLE request (https://upstox.com/developer/api-documentation/v3/get-historical-candle-data/,
 * checked 2026-10-10, cross-referenced against the V3 launch announcement):
 *   - "minutes" unit, interval 1-15: max 1 month per request.
 *   - "minutes" unit, interval >15, and "hours" unit (interval 1-5): max 1
 *     quarter per request.
 *   - "days"/"weeks"/"months": max 1 decade / no limit — chunking is never
 *     needed for those in practice at this app's scale.
 * Sized to 31/91 (not a flush 30/90) so a calendar month/quarter's actual
 * day count (28-31 / 90-92) always fits in one chunk — this also matters
 * because several existing default windows elsewhere in this file already
 * span a plain 30-day/90-day subtraction (inclusive of both endpoints, i.e.
 * 31/91 calendar days), and a threshold below that would spuriously chunk
 * those pre-existing default-window fetches into two requests instead of
 * one, a regression caught by tests/historicalCandleCache.test.js.
 *
 * Separately, Upstox only retains intraday (minutes/hours) data from
 * January 2022 onward — a RETENTION limit, not a per-request window limit;
 * no amount of chunking can retrieve intraday data older than that, so a
 * requested range reaching further back is clamped (see
 * `clampToIntradayRetention`) and the clamp is surfaced as a data-quality
 * disclosure by callers that need one (`fetchHistoricalCandlesWithQuality`),
 * never silently treated as "the full requested range was fetched."
 */
const MAX_WINDOW_DAYS = {
    minutesShort: 31,
    minutesLong: 91,
    hours: 91,
};
const INTRADAY_RETENTION_START = "2022-01-01";

function getMaxWindowDaysFor(unit, interval) {
    if (unit === "hours") return MAX_WINDOW_DAYS.hours;
    if (unit === "minutes") {
        return Number(interval) <= 15 ? MAX_WINDOW_DAYS.minutesShort : MAX_WINDOW_DAYS.minutesLong;
    }
    return Infinity;
}

function clampToIntradayRetention(fromDate) {
    return fromDate < INTRADAY_RETENTION_START ? INTRADAY_RETENTION_START : fromDate;
}

function addDaysToDateString(dateStr, days) {
    const d = new Date(`${dateStr}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
}

/** Splits [fromDate, toDate] (inclusive, 'YYYY-MM-DD') into consecutive
 *  sub-ranges each spanning at most `maxWindowDays`, oldest first. Pure,
 *  no I/O — the actual fetching/caching/retrying of each chunk is a
 *  separate concern (`fetchHistoricalCandlesChunked` below), so this is
 *  independently unit-testable. */
function splitDateRangeIntoChunks(fromDate, toDate, maxWindowDays) {
    if (!Number.isFinite(maxWindowDays) || maxWindowDays <= 0) {
        return [{ fromDate, toDate }];
    }

    const chunks = [];
    let chunkFrom = fromDate;

    while (chunkFrom <= toDate) {
        const naturalEnd = addDaysToDateString(chunkFrom, maxWindowDays - 1);
        const chunkTo = naturalEnd > toDate ? toDate : naturalEnd;
        chunks.push({ fromDate: chunkFrom, toDate: chunkTo });
        chunkFrom = addDaysToDateString(chunkTo, 1);
    }

    return chunks;
}

const RSI_CANDLE_CONFIGS = [
    { interval: "minutes", unit: "1" },
    { interval: "minutes", unit: "5" },
    { interval: "minutes", unit: "15" },
    { interval: "hours", unit: "1" },
    { interval: "days", unit: "1" },
];

function getAccessToken() {
    return process.env.UPSTOX_ACCESS_TOKEN || process.env.UPSTOX_TOKEN || "";
}

function extractUpstoxErrorMessage(error) {
    return (
        error.response?.data?.errors?.[0]?.message ||
        error.response?.data?.message ||
        error.message ||
        ""
    );
}

function handleCandleApiError(instrumentKey, error) {
    const message = extractUpstoxErrorMessage(error);

    if (isInvalidInstrumentMessage(message)) {
        markInstrumentKeyInvalid(instrumentKey, message);
        return true;
    }

    return false;
}

const assertCandleInstrumentKey = canFetchCandles;

function formatDate(date) {
    return date.toISOString().slice(0, 10);
}

function getDateRangeForUnit(unit) {
    const toDate = formatDate(new Date());

    if (unit === "minutes") {
        return {
            toDate,
            fromDate: formatDate(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)),
        };
    }

    if (unit === "hours") {
        return {
            toDate,
            fromDate: formatDate(new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)),
        };
    }

    return {
        toDate,
        fromDate: formatDate(new Date(Date.now() - 365 * 24 * 60 * 60 * 1000)),
    };
}

async function fetchIntradayCandles(instrumentKey, options = {}) {
    const token = getAccessToken();
    if (!token || !(await assertCandleInstrumentKey(instrumentKey))) return [];

    const rawUnit = options.interval || "minutes";
    const rawInterval = options.unit || "1";
    const unit = rawUnit === "hours" ? "minutes" : rawUnit;
    const interval =
        rawUnit === "hours" ? String(Number(rawInterval) * 60) : rawInterval;
    const encodedKey = encodeURIComponent(instrumentKey);
    const url = `https://api.upstox.com/v3/historical-candle/intraday/${encodedKey}/${unit}/${interval}`;
    const maxBars = options.maxBars || 250;

    try {
        const response = await enqueue(() =>
            axios.get(url, {
                headers: {
                    Accept: "application/json",
                    Authorization: `Bearer ${token}`,
                },
                timeout: 20000,
            }),
        );

        const candles = response.data?.data?.candles || response.data?.candles || [];

        return candles
            .map(normalizeCandle)
            .filter((candle) => Number.isFinite(candle.close))
            .reverse()
            .slice(-maxBars);
    } catch (error) {
        if (handleCandleApiError(instrumentKey, error)) {
            return [];
        }
        throw error;
    }
}

function normalizeCandle(raw) {
    if (Array.isArray(raw)) {
        const [timestamp, open, high, low, close, volume, oi] = raw;
        return {
            timestamp,
            open: Number(open),
            high: Number(high),
            low: Number(low),
            close: Number(close),
            volume: Number(volume || 0),
            oi: Number(oi || 0),
        };
    }

    return {
        timestamp: raw.timestamp || raw.ts || raw.date,
        open: Number(raw.open),
        high: Number(raw.high),
        low: Number(raw.low),
        close: Number(raw.close),
        volume: Number(raw.volume || raw.vol || 0),
        oi: Number(raw.oi || 0),
    };
}

async function fetchHistoricalCandlesByRange(
    instrumentKey,
    unit,
    interval,
    fromDate,
    toDate,
    options = {},
) {
    const maxBars = options.maxBars || 500;
    const token = getAccessToken();
    if (!token || !(await assertCandleInstrumentKey(instrumentKey))) return [];

    const encodedKey = encodeURIComponent(instrumentKey);
    const url = `https://api.upstox.com/v3/historical-candle/${encodedKey}/${unit}/${interval}/${toDate}/${fromDate}`;

    try {
        const response = await enqueue(() =>
            axios.get(url, {
                headers: {
                    Accept: "application/json",
                    Authorization: `Bearer ${token}`,
                },
                timeout: 20000,
            }),
        );

        const candles = response.data?.data?.candles || response.data?.candles || [];
        return candles
            .map(normalizeCandle)
            .filter((candle) => Number.isFinite(candle.close))
            .reverse()
            .slice(-maxBars);
    } catch (error) {
        if (handleCandleApiError(instrumentKey, error)) {
            return [];
        }
        throw error;
    }
}

function bucketHourTimestamp(value) {
    const ts = new Date(value).getTime();
    if (!Number.isFinite(ts)) return null;
    const bucket = Math.floor(ts / (60 * 60 * 1000)) * 60 * 60 * 1000;
    return new Date(bucket).toISOString();
}

function aggregateToHourlyCandles(candles = []) {
    if (!Array.isArray(candles) || !candles.length) return [];

    const grouped = new Map();

    candles.forEach((candle) => {
        const hourKey = bucketHourTimestamp(candle.timestamp);
        if (!hourKey) return;

        const close = Number(candle.close);
        if (!Number.isFinite(close)) return;

        const open = Number(candle.open);
        const high = Number(candle.high);
        const low = Number(candle.low);
        const volume = Number(candle.volume || 0);
        const oi = Number(candle.oi || 0);

        const existing = grouped.get(hourKey);
        if (!existing) {
            grouped.set(hourKey, {
                timestamp: hourKey,
                open: Number.isFinite(open) ? open : close,
                high: Number.isFinite(high) ? high : close,
                low: Number.isFinite(low) ? low : close,
                close,
                volume: Number.isFinite(volume) ? volume : 0,
                oi: Number.isFinite(oi) ? oi : 0,
            });
            return;
        }

        existing.high = Math.max(existing.high, Number.isFinite(high) ? high : close);
        existing.low = Math.min(existing.low, Number.isFinite(low) ? low : close);
        existing.close = close;
        existing.volume += Number.isFinite(volume) ? volume : 0;
        if (Number.isFinite(oi)) existing.oi = oi;
    });

    return [...grouped.values()].sort(
        (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );
}

/**
 * Cache-aware wrapper around `fetchHistoricalCandlesByRange` for ONE
 * request-sized window (never spanning more than a provider-imposed
 * window — callers are responsible for chunking first). Concurrent
 * callers for the same (instrument, unit, interval, date range, maxBars)
 * share one in-flight fetch via `dedupe()`, independent of `getCandles()`'s
 * own outer-level dedupe (which covers the whole historical+intraday
 * call, not just this piece).
 *
 * Unlike the legacy-compatible `fetchHistoricalCandles`/`getCandles`
 * (which silently swallow a failed range fetch to `[]`, the existing
 * graceful-degradation convention throughout this module), this returns
 * `{candles, error}` — failure is visible to any caller that needs to
 * know ("never fabricate... detect missing/partial chunks"). Callers that
 * want the old silent-failure behavior just read `.candles` and ignore
 * `.error`, which is exactly what the legacy-compatible wrappers below do.
 */
async function fetchCachedHistoricalRange(instrumentKey, unit, interval, fromDate, toDate, maxBars) {
    const cacheKey = `${instrumentKey}:${unit}:${interval}:${fromDate}:${toDate}:${maxBars || ""}`;

    const cached = historicalRangeCandleCache.get(cacheKey);
    if (cached !== undefined) {
        return { candles: cached, error: null };
    }

    const result = await dedupe(`historical-range:${cacheKey}`, async () => {
        try {
            const candles = await fetchHistoricalCandlesByRange(instrumentKey, unit, interval, fromDate, toDate, { maxBars });
            return { candles, error: null };
        } catch (error) {
            return { candles: [], error };
        }
    });

    if (result.candles.length) {
        historicalRangeCandleCache.set(cacheKey, result.candles);
    }

    return result;
}

/**
 * Fetches a (possibly multi-year) historical range by splitting it into
 * provider-window-sized chunks (see `MAX_WINDOW_DAYS`/`splitDateRangeIntoChunks`),
 * fetching each chunk through the SAME cache/dedupe/retry path as a
 * single-shot request (`fetchCachedHistoricalRange` -> `fetchHistoricalCandlesByRange`
 * -> the existing Upstox queue's retry/backoff — nothing new is added at
 * that layer), then merging and deduplicating by exact timestamp
 * (`mergeCandlesByTimestamp`, chronological order preserved).
 *
 * Chunks are fetched concurrently (`Promise.all`) — safe because each
 * chunk has a distinct cache key (its own date range), so there is no
 * cache-key-collision risk the way there would be racing DIFFERENT
 * timeframes of the same instrument (see professionalCandleAdapter.js's
 * comment on why THAT loop stays sequential). The existing queue's own
 * concurrency cap + per-call rate-gap still governs the real network
 * request rate; this just lets multiple chunks queue up at once instead
 * of waiting on each other's full round trip first.
 *
 * Returns `{candles, incomplete, failedRanges, retentionClamped,
 * retentionFrom}` — `incomplete`/`failedRanges` are populated only when a
 * chunk's fetch genuinely failed (exhausted retries or a non-retryable
 * error), never inferred from "this chunk happened to come back empty"
 * (a legitimately data-free window — e.g. before listing, or a holiday-only
 * span — is not an error and is not reported as one).
 */
async function fetchHistoricalCandlesChunked(instrumentKey, unit, interval, fromDate, toDate, { maxWindowDays, maxBars } = {}) {
    const clampedFromDate = clampToIntradayRetention(fromDate);
    const retentionClamped = clampedFromDate !== fromDate;

    if (clampedFromDate > toDate) {
        // The entire requested range predates what Upstox retains for this
        // granularity — nothing to fetch, and definitely nothing to fabricate.
        return { candles: [], incomplete: false, failedRanges: [], retentionClamped: true, retentionFrom: INTRADAY_RETENTION_START };
    }

    const chunks = splitDateRangeIntoChunks(clampedFromDate, toDate, maxWindowDays);

    const results = await Promise.all(
        chunks.map((chunk) =>
            fetchCachedHistoricalRange(instrumentKey, unit, interval, chunk.fromDate, chunk.toDate, maxBars).then((r) => ({
                ...chunk,
                ...r,
            })),
        ),
    );

    const failedRanges = results.filter((r) => r.error).map((r) => ({ fromDate: r.fromDate, toDate: r.toDate }));
    const allCandles = results.flatMap((r) => r.candles || []);
    const merged = mergeCandlesByTimestamp(allCandles, []);
    const bounded = maxBars ? merged.slice(-maxBars) : merged;

    return {
        candles: bounded,
        incomplete: failedRanges.length > 0,
        failedRanges,
        retentionClamped,
        retentionFrom: INTRADAY_RETENTION_START,
    };
}

function diffDaysInclusive(fromDate, toDate) {
    const msPerDay = 24 * 60 * 60 * 1000;
    return Math.round((new Date(`${toDate}T00:00:00Z`) - new Date(`${fromDate}T00:00:00Z`)) / msPerDay) + 1;
}

/**
 * The single entry point for "fetch this historical range, chunking only
 * if the span actually exceeds what Upstox allows in one request." For a
 * short range (the common case — live indicator refresh, small backtests)
 * this is a single cached fetch, identical in shape/cost to the
 * pre-chunking behavior. For a long range (e.g. a 365-day 5m/1h backtest)
 * it transparently fans out into cached chunks.
 */
async function fetchHistoricalRangeMaybeChunked(instrumentKey, unit, interval, fromDate, toDate, maxBars) {
    const maxWindowDays = getMaxWindowDaysFor(unit, interval);
    const spanDays = diffDaysInclusive(fromDate, toDate);

    if (spanDays <= maxWindowDays) {
        // The 2022-01-01 floor is an INTRADAY-only retention limit (see this
        // file's top-of-file comment) — applying it to "days"/"weeks"/
        // "months" unit requests would incorrectly clamp a genuinely
        // available multi-year daily history. Every existing caller of this
        // function only ever passes "minutes"/"hours" (grep-verified), so
        // this guard is a no-op for them and only matters for a new
        // "days"-unit caller (the Grid Backtest's historical range fetch).
        const isIntraday = unit === "minutes" || unit === "hours";
        const clampedFromDate = isIntraday ? clampToIntradayRetention(fromDate) : fromDate;
        const retentionClamped = clampedFromDate !== fromDate;
        if (clampedFromDate > toDate) {
            return { candles: [], incomplete: false, failedRanges: [], retentionClamped: true, retentionFrom: INTRADAY_RETENTION_START };
        }
        const { candles, error } = await fetchCachedHistoricalRange(instrumentKey, unit, interval, clampedFromDate, toDate, maxBars);
        return {
            candles: maxBars ? candles.slice(-maxBars) : candles,
            incomplete: !!error,
            failedRanges: error ? [{ fromDate: clampedFromDate, toDate }] : [],
            retentionClamped,
            retentionFrom: INTRADAY_RETENTION_START,
        };
    }

    return fetchHistoricalCandlesChunked(instrumentKey, unit, interval, fromDate, toDate, { maxWindowDays, maxBars });
}

function getDateRangeForPeriodDays(unit, periodDays = 365) {
    const toDate = formatDate(new Date());
    const days = Math.max(1, Number(periodDays) || 365);
    const fromDate = formatDate(new Date(Date.now() - days * 24 * 60 * 60 * 1000));
    return { toDate, fromDate };
}

function candleTimestampKey(candle) {
    const ms = new Date(candle?.timestamp).getTime();
    return Number.isFinite(ms) ? ms : null;
}

function mergeCandlesByTimestamp(primary = [], secondary = []) {
    const byMs = new Map();

    [...primary, ...secondary].forEach((candle) => {
        const key = candleTimestampKey(candle);
        if (key == null) return;
        byMs.set(key, candle);
    });

    return [...byMs.values()].sort(
        (a, b) => candleTimestampKey(a) - candleTimestampKey(b),
    );
}

const EMPTY_QUALITY = { incomplete: false, failedRanges: [], retentionClamped: false, retentionFrom: null };

/**
 * Does the actual work for both `fetchHistoricalCandles` (legacy-compatible,
 * plain-array return, silent degradation) and `fetchHistoricalCandlesWithQuality`
 * (new, returns completeness metadata alongside the candles) — one
 * implementation, two return shapes, so the two callers can never drift.
 */
async function fetchHistoricalCandlesInternal(instrumentKey, options = {}) {
    const token = getAccessToken();
    if (!token || !(await assertCandleInstrumentKey(instrumentKey))) {
        return { candles: [], ...EMPTY_QUALITY };
    }

    const requestedUnit = options.interval || "days";
    const requestedInterval = options.unit || "1";
    const periodDays = options.periodDays;
    const maxBars = options.maxBars || 500;

    if (isInstrumentKeyBlocked(instrumentKey)) {
        return { candles: [], ...EMPTY_QUALITY };
    }

    if (requestedUnit === "hours") {
        // Previously hardcoded to a fixed 90-day window via
        // getDateRangeForUnit("hours") regardless of the caller's
        // requested periodDays — the root cause of 1h backtests never
        // being able to see more than 90 days even when the caller asked
        // for more. Now respects periodDays exactly like "minutes" does,
        // and chunks via fetchHistoricalRangeMaybeChunked when the span
        // exceeds Upstox's documented per-request window for this
        // granularity (60-minute interval -> the ">15min" quarter bucket).
        const range = periodDays != null ? getDateRangeForPeriodDays("minutes", periodDays) : getDateRangeForUnit("hours");
        const { toDate, fromDate } = range;

        const directHourly = await fetchHistoricalRangeMaybeChunked(instrumentKey, "minutes", "60", fromDate, toDate, maxBars);
        if (directHourly.candles.length) {
            return { candles: directHourly.candles, incomplete: directHourly.incomplete, failedRanges: directHourly.failedRanges, retentionClamped: directHourly.retentionClamped, retentionFrom: directHourly.retentionFrom };
        }

        const minuteCandles = await fetchIntradayCandles(instrumentKey, {
            interval: "minutes",
            unit: "1",
        });
        const hourly = aggregateToHourlyCandles(minuteCandles);
        if (hourly.length) {
            return { candles: hourly.slice(-maxBars), incomplete: directHourly.incomplete, failedRanges: directHourly.failedRanges, retentionClamped: directHourly.retentionClamped, retentionFrom: directHourly.retentionFrom };
        }
    }

    const unit = requestedUnit;
    const interval = requestedInterval;

    if (unit === "minutes") {
        const range =
            periodDays != null
                ? getDateRangeForPeriodDays(unit, periodDays)
                : getDateRangeForUnit(unit);
        const { toDate, fromDate } = range;

        const historicalResult = await fetchHistoricalRangeMaybeChunked(instrumentKey, unit, interval, fromDate, toDate, maxBars);
        const historical = historicalResult.candles;

        const intraday = await fetchIntradayCandles(instrumentKey, {
            interval: unit,
            unit: interval,
            maxBars,
        }).catch(() => []);

        const quality = {
            incomplete: historicalResult.incomplete,
            failedRanges: historicalResult.failedRanges,
            retentionClamped: historicalResult.retentionClamped,
            retentionFrom: historicalResult.retentionFrom,
        };

        if (historical.length && intraday.length) {
            return { candles: mergeCandlesByTimestamp(historical, intraday).slice(-maxBars), ...quality };
        }
        if (intraday.length) return { candles: intraday.slice(-maxBars), ...quality };
        if (historical.length) return { candles: historical.slice(-maxBars), ...quality };
    }

    if (unit === "hours") {
        const intraday = await fetchIntradayCandles(instrumentKey, {
            interval: unit,
            unit: interval,
            maxBars,
        });
        if (intraday.length) return { candles: intraday, ...EMPTY_QUALITY };
    }

    if (isInstrumentKeyBlocked(instrumentKey)) {
        return { candles: [], ...EMPTY_QUALITY };
    }

    const range =
        periodDays != null
            ? getDateRangeForPeriodDays(unit, periodDays)
            : getDateRangeForUnit(unit);
    const { toDate, fromDate } = range;

    const candles = await fetchHistoricalCandlesByRange(
        instrumentKey,
        unit,
        interval,
        fromDate,
        toDate,
        { maxBars },
    );
    return { candles: candles.slice(-maxBars), ...EMPTY_QUALITY };
}

/** Legacy-compatible: plain array, silent degradation on failure — exact
 *  same external contract every existing caller already depends on. */
async function fetchHistoricalCandles(instrumentKey, options = {}) {
    const result = await fetchHistoricalCandlesInternal(instrumentKey, options);
    return result.candles;
}

/** New: same fetch, but surfaces completeness so a caller that cares
 *  (the professional backtest path) can disclose it instead of silently
 *  treating a partially-fetched long range as if it were complete. */
async function fetchHistoricalCandlesWithQuality(instrumentKey, options = {}) {
    return fetchHistoricalCandlesInternal(instrumentKey, options);
}

async function getCandles(instrumentKey, options = {}) {
    if (!instrumentKey || isInstrumentKeyBlocked(instrumentKey)) return [];

    if (!(await assertCandleInstrumentKey(instrumentKey))) {
        return [];
    }

    const requestedUnit = options.interval || "days";
    const requestedInterval = options.unit || "1";
    const periodDays = options.periodDays;
    const maxBars = options.maxBars;
    const normalizedUnit = requestedUnit;
    const normalizedInterval = requestedInterval;

    const key = `${instrumentKey}:${normalizedUnit}:${normalizedInterval}:${periodDays || ""}:${maxBars || ""}`;

    return dedupe(`candles:${key}`, async () => {
        try {
            return await fetchHistoricalCandles(instrumentKey, {
                interval: requestedUnit,
                unit: requestedInterval,
                periodDays,
                maxBars,
            });
        } catch {
            return [];
        }
    });
}

/**
 * Same fetch as `getCandles`, but resolves to `{candles, incomplete,
 * failedRanges, retentionClamped, retentionFrom}` instead of a plain array
 * — used by the professional backtest path, which must disclose (never
 * fabricate) coverage for a long chunked range. Deliberately uses its own
 * dedupe-key namespace (`candles-wq:` vs. `getCandles`'s `candles:`)
 * rather than sharing `getCandles`'s in-flight entries, since the two
 * resolve to different shapes; the underlying chunk-level cache
 * (`historicalRangeCandleCache`) is still shared, so this doesn't
 * duplicate any actual network fetch that `getCandles` already made for
 * the same instrument/range, only the thin in-flight-collapsing layer
 * above it.
 */
async function getCandlesWithQuality(instrumentKey, options = {}) {
    if (!instrumentKey || isInstrumentKeyBlocked(instrumentKey)) {
        return { candles: [], ...EMPTY_QUALITY };
    }

    if (!(await assertCandleInstrumentKey(instrumentKey))) {
        return { candles: [], ...EMPTY_QUALITY };
    }

    const requestedUnit = options.interval || "days";
    const requestedInterval = options.unit || "1";
    const periodDays = options.periodDays;
    const maxBars = options.maxBars;

    const key = `${instrumentKey}:${requestedUnit}:${requestedInterval}:${periodDays || ""}:${maxBars || ""}`;

    return dedupe(`candles-wq:${key}`, async () => {
        try {
            return await fetchHistoricalCandlesWithQuality(instrumentKey, {
                interval: requestedUnit,
                unit: requestedInterval,
                periodDays,
                maxBars,
            });
        } catch (error) {
            return { candles: [], incomplete: true, failedRanges: [{ error: error.message }], retentionClamped: false, retentionFrom: null };
        }
    });
}

async function warmCandles(instrumentKeys = []) {
    const uniqueKeys = [
        ...new Set(instrumentKeys.filter(Boolean)),
    ];
    const validKeys = [];

    for (const key of uniqueKeys) {
        if (await canFetchCandles(key)) {
            validKeys.push(key);
        }
    }

    const jobs = [];

    validKeys.forEach((key) => {
        RSI_CANDLE_CONFIGS.forEach((cfg) => {
            jobs.push(getCandles(key, cfg).catch(() => []));
        });
    });

    await Promise.allSettled(jobs);
}

function toBacktestQuote(candle) {
    return {
        date: new Date(candle.timestamp),
        open: candle.open ?? candle.close,
        high: candle.high ?? candle.close,
        low: candle.low ?? candle.close,
        close: candle.close,
        volume: candle.volume ?? 0,
    };
}

module.exports = {
    getCandles,
    warmCandles,
    RSI_CANDLE_CONFIGS,
    toBacktestQuote,
    normalizeCandle,
    // Exposed for the new backtest candle-chart endpoint (Historical Candle
    // Chart milestone): fetchCandleSeriesForBacktest/getCandles resolve a
    // date range relative to "today," which is wrong for charting an
    // OLDER backtest's exact historical window — this function already
    // takes an explicit fromDate/toDate and goes through the same queue/
    // cache/retry path, so it's reused directly rather than duplicated.
    fetchHistoricalCandlesByRange,
    // Longer-backtest-history milestone (2026-10-10): chunked, data-quality-aware
    // fetching for timeframes whose requested range exceeds Upstox's
    // documented per-request window (5m/15m/1h, now able to cover up to
    // ~365 days instead of being capped at a single request's window).
    getCandlesWithQuality,
    fetchHistoricalCandlesWithQuality,
    // Exposed for the Grid Backtest (ADR-025): the only existing function
    // that takes an EXPLICIT arbitrary fromDate/toDate (not relative to
    // "today") AND returns quality metadata — reused directly rather than
    // duplicating chunking/cache/retry/quality-disclosure logic.
    fetchHistoricalRangeMaybeChunked,
    splitDateRangeIntoChunks,
    getMaxWindowDaysFor,
    clampToIntradayRetention,
    MAX_WINDOW_DAYS,
    INTRADAY_RETENTION_START,
};
