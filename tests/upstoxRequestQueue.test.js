const assert = require("assert");

process.env.UPSTOX_REQUEST_GAP_MS = "0";
process.env.UPSTOX_RETRY_BASE_MS = "5";
process.env.UPSTOX_RETRY_MAX_MS = "20";
process.env.UPSTOX_MAX_RETRIES = "3";

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

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
