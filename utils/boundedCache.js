/**
 * Small reusable TTL + max-size cache for the various lookup caches scattered
 * across the Upstox services (PE ratios, instrument search, invalid-key
 * tracking). Not meant for "live" state like liveData/indicatorSnapshot,
 * which are freshness maps pruned directly on unsubscribe instead.
 *
 * - TTL: entries older than `ttlMs` are treated as expired on read, and swept
 *   out in the background every `sweepIntervalMs` so unread-but-stale entries
 *   don't linger forever.
 * - Max size: when `set()` would exceed `maxSize`, the least-recently-set
 *   entry is evicted (Map preserves insertion order; re-setting a key moves
 *   it to the back).
 */
function createBoundedCache({ maxSize = 500, ttlMs = null, sweepIntervalMs = 5 * 60 * 1000 } = {}) {
    const store = new Map();

    function isExpired(entry) {
        return ttlMs != null && Date.now() - entry.updatedAt > ttlMs;
    }

    function get(key) {
        const entry = store.get(key);
        if (!entry) return undefined;
        if (isExpired(entry)) {
            store.delete(key);
            return undefined;
        }
        return entry.value;
    }

    function set(key, value) {
        store.delete(key);
        store.set(key, { value, updatedAt: Date.now() });

        if (store.size > maxSize) {
            const oldestKey = store.keys().next().value;
            store.delete(oldestKey);
        }
    }

    function has(key) {
        return get(key) !== undefined;
    }

    function del(key) {
        store.delete(key);
    }

    function sweep() {
        if (ttlMs == null) return 0;
        let removed = 0;
        for (const [key, entry] of store) {
            if (isExpired(entry)) {
                store.delete(key);
                removed += 1;
            }
        }
        return removed;
    }

    const sweepTimer = setInterval(sweep, sweepIntervalMs);
    sweepTimer.unref();

    return {
        get,
        set,
        has,
        delete: del,
        sweep,
        stopSweep: () => clearInterval(sweepTimer),
        get size() {
            return store.size;
        },
    };
}

module.exports = { createBoundedCache };
