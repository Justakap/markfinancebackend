const assert = require("assert");

process.env.UPSTOX_REQUEST_GAP_MS = "0";
process.env.UPSTOX_RETRY_BASE_MS = "5";
process.env.UPSTOX_RETRY_MAX_MS = "20";
process.env.UPSTOX_MAX_RETRIES = "3";
process.env.UPSTOX_QUEUE_CONCURRENCY = "3";

// Re-require after env vars are set so the module picks up the fast test timings.
delete require.cache[require.resolve("../utils/upstoxRequestQueue")];
const { enqueue } = require("../utils/upstoxRequestQueue");
const { dedupe } = require("../utils/requestDedup");

let passed = 0;
let failed = 0;

async function test(name, fn) {
    try {
        await fn();
        passed += 1;
        console.log(`  ✓ ${name}`);
    } catch (error) {
        failed += 1;
        console.error(`  ✗ ${name}`);
        console.error(`    ${error.message}`);
    }
}

function httpError(status, { retryAfter, code } = {}) {
    const error = new Error(`Request failed with status ${status || ""}`.trim());
    if (status) {
        error.response = { status, headers: retryAfter ? { "retry-after": String(retryAfter) } : {} };
        error.request = {};
    } else {
        // Network/timeout style error — axios sets `request` but no `response`.
        error.request = {};
        if (code) error.code = code;
    }
    return error;
}

(async () => {
    console.log("Upstox request queue — throttle, retry, dedupe\n");

    await test("1. normal request resolves with the task's value", async () => {
        const result = await enqueue(() => Promise.resolve("ok"));
        assert.strictEqual(result, "ok");
    });

    await test("5. simultaneous identical requests are deduped to one call", async () => {
        let calls = 0;
        const fn = () =>
            new Promise((resolve) => setTimeout(() => resolve(++calls), 10));

        const [a, b, c] = await Promise.all([
            dedupe("same-key", fn),
            dedupe("same-key", fn),
            dedupe("same-key", fn),
        ]);

        assert.strictEqual(calls, 1, "underlying fetcher should run exactly once");
        assert.strictEqual(a, b);
        assert.strictEqual(b, c);
    });

    await test("cache hit: repeated dedupe key after completion allows a fresh call", async () => {
        let calls = 0;
        const fn = () => Promise.resolve(++calls);

        await dedupe("key-2", fn);
        await dedupe("key-2", fn);

        assert.strictEqual(calls, 2, "a new call after the first resolves should not be deduped forever");
    });

    await test("6. 429 with Retry-After honors the header and eventually succeeds", async () => {
        let attempts = 0;
        const result = await enqueue(() => {
            attempts += 1;
            if (attempts < 2) return Promise.reject(httpError(429, { retryAfter: 0.01 }));
            return Promise.resolve("recovered");
        });

        assert.strictEqual(result, "recovered");
        assert.strictEqual(attempts, 2);
    });

    await test("7. 429 without Retry-After falls back to exponential backoff + jitter", async () => {
        let attempts = 0;
        const result = await enqueue(() => {
            attempts += 1;
            if (attempts < 2) return Promise.reject(httpError(429));
            return Promise.resolve("recovered-no-header");
        });

        assert.strictEqual(result, "recovered-no-header");
        assert.strictEqual(attempts, 2);
    });

    await test("8. repeated 429 beyond max retries throws instead of retrying forever", async () => {
        let attempts = 0;
        await assert.rejects(
            enqueue(() => {
                attempts += 1;
                return Promise.reject(httpError(429));
            }),
        );
        assert.strictEqual(attempts, 4, "1 initial attempt + 3 retries, then give up");
    });

    await test("9. permanent 400 is never retried", async () => {
        let attempts = 0;
        await assert.rejects(
            enqueue(() => {
                attempts += 1;
                return Promise.reject(httpError(400));
            }),
        );
        assert.strictEqual(attempts, 1);
    });

    await test("10. permanent 401/403 is never retried", async () => {
        let attempts = 0;
        await assert.rejects(
            enqueue(() => {
                attempts += 1;
                return Promise.reject(httpError(401));
            }),
        );
        assert.strictEqual(attempts, 1);
    });

    await test("11. request timeout (no response) is retried then can succeed", async () => {
        let attempts = 0;
        const result = await enqueue(() => {
            attempts += 1;
            if (attempts < 2) return Promise.reject(httpError(null, { code: "ECONNABORTED" }));
            return Promise.resolve("recovered-after-timeout");
        });

        assert.strictEqual(result, "recovered-after-timeout");
        assert.strictEqual(attempts, 2);
    });

    await test("queue stays alive after a permanent failure (no wedging)", async () => {
        await assert.rejects(enqueue(() => Promise.reject(httpError(400))));
        const result = await enqueue(() => Promise.resolve("still works"));
        assert.strictEqual(result, "still works");
    });

    await test("critical-priority requests jump ahead of a queued (not yet dispatched) background backlog", async () => {
        // Concurrency is 3 (see env above). Seed more background tasks than
        // that, so some are immediately dispatched and some are left queued —
        // then confirm a critical request finishes before the still-queued
        // background tasks it jumped ahead of, rather than asserting a full
        // global order (the already-dispatched ones run concurrently and may
        // legitimately finish in any relative order against the critical one).
        const order = [];
        const makeTask = (label, ms) => () =>
            new Promise((resolve) =>
                setTimeout(() => {
                    order.push(label);
                    resolve(label);
                }, ms),
            );

        const backgroundRuns = [
            enqueue(makeTask("bg-1", 15), { priority: "background" }), // dispatched immediately (slot 1/3)
            enqueue(makeTask("bg-2", 15), { priority: "background" }), // dispatched immediately (slot 2/3)
            enqueue(makeTask("bg-3", 15), { priority: "background" }), // dispatched immediately (slot 3/3)
            enqueue(makeTask("bg-4", 5), { priority: "background" }), // left queued — concurrency full
            enqueue(makeTask("bg-5", 5), { priority: "background" }), // left queued — concurrency full
        ];
        const criticalRun = enqueue(makeTask("critical", 5), { priority: "critical" });

        await Promise.all([...backgroundRuns, criticalRun]);

        const criticalIndex = order.indexOf("critical");
        const bg4Index = order.indexOf("bg-4");
        const bg5Index = order.indexOf("bg-5");
        assert.ok(
            criticalIndex < bg4Index && criticalIndex < bg5Index,
            `critical should finish before the still-queued background tasks it jumped ahead of (order: ${order.join(",")})`,
        );
    });

    await test("default priority (no options) behaves as background", async () => {
        const order = [];
        const makeTask = (label, ms) => () =>
            new Promise((resolve) =>
                setTimeout(() => {
                    order.push(label);
                    resolve(label);
                }, ms),
            );

        // Fill all 3 concurrency slots with slow default-priority tasks so a
        // subsequently queued critical task is forced to wait in line behind
        // whichever (default-priority) backlog entries are still queued.
        const defaultRuns = [
            enqueue(makeTask("default-1", 15), {}),
            enqueue(makeTask("default-2", 15), {}),
            enqueue(makeTask("default-3", 15), {}),
            enqueue(makeTask("default-4", 5), {}),
        ];
        const criticalRun = enqueue(makeTask("critical-2", 5), { priority: "critical" });

        await Promise.all([...defaultRuns, criticalRun]);

        assert.ok(
            order.indexOf("critical-2") < order.indexOf("default-4"),
            `critical should jump the still-queued default-priority backlog (order: ${order.join(",")})`,
        );
    });

    await test("concurrency: multiple requests overlap in flight instead of fully serializing", async () => {
        const concurrencyStart = Date.now();
        const TASK_MS = 40;

        await Promise.all([
            enqueue(() => new Promise((resolve) => setTimeout(resolve, TASK_MS))),
            enqueue(() => new Promise((resolve) => setTimeout(resolve, TASK_MS))),
            enqueue(() => new Promise((resolve) => setTimeout(resolve, TASK_MS))),
        ]);

        const elapsed = Date.now() - concurrencyStart;
        // Fully serialized would take ~3 * TASK_MS (~120ms); with concurrency 3
        // they should overlap and finish close to a single TASK_MS window.
        assert.ok(
            elapsed < TASK_MS * 2,
            `3 concurrent ${TASK_MS}ms tasks should overlap, took ${elapsed}ms (expected < ${TASK_MS * 2}ms)`,
        );
    });

    await test("concurrency is bounded: a 4th task waits for a freed slot", async () => {
        const TASK_MS = 30;
        let activePeak = 0;
        let active = 0;

        const makeTask = () => async () => {
            active += 1;
            activePeak = Math.max(activePeak, active);
            await new Promise((resolve) => setTimeout(resolve, TASK_MS));
            active -= 1;
            return null;
        };

        await Promise.all([
            enqueue(makeTask()),
            enqueue(makeTask()),
            enqueue(makeTask()),
            enqueue(makeTask()),
            enqueue(makeTask()),
        ]);

        assert.strictEqual(activePeak, 3, "peak concurrent tasks should never exceed UPSTOX_QUEUE_CONCURRENCY (3)");
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
