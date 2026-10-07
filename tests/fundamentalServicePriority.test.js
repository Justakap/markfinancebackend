const assert = require("assert");

process.env.UPSTOX_ACCESS_TOKEN = "fake-token-for-tests";

// Mock utils/upstoxRequestQueue's enqueue() so we can assert exactly which
// priority fundamentalService passes through, without needing a real
// network call or the full queue machinery (already covered by
// upstoxRequestQueue.test.js).
const queuePath = require.resolve("../utils/upstoxRequestQueue");
const capturedPriorities = [];

require.cache[queuePath] = {
    id: queuePath,
    filename: queuePath,
    loaded: true,
    exports: {
        enqueue: (task, options = {}) => {
            capturedPriorities.push(options.priority);
            return task();
        },
        isRetryableError: () => false,
        getRetryAfterMs: () => null,
    },
};

delete require.cache[require.resolve("../services/fundamentalService")];
const { getPeForInstrument, warmPeForInstruments } = require("../services/fundamentalService");

const axios = require("axios");
const originalAxiosGet = axios.get.bind(axios);
axios.get = (url, config) => {
    if (url.includes("/fundamentals/")) {
        return Promise.resolve({
            data: { data: [{ name: "P/E", company_value: "25.5" }] },
        });
    }
    return originalAxiosGet(url, config);
};

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

(async () => {
    console.log("fundamentalService — PE warming queue priority\n");

    await test("warmPeForInstruments enqueues every PE lookup at 'low' priority", async () => {
        capturedPriorities.length = 0;

        await warmPeForInstruments([
            { instrumentKey: "NSE_EQ|INE000A01001", instrumentType: "EQ" },
            { instrumentKey: "NSE_EQ|INE000B01002", instrumentType: "EQ" },
        ]);

        assert.ok(capturedPriorities.length >= 2, "expected at least one enqueue() call per instrument");
        capturedPriorities.forEach((p) =>
            assert.strictEqual(p, "low", "every PE-warming call must be enqueued at 'low' priority"),
        );
    });

    await test("a direct getPeForInstrument call (no options) uses default (background) priority, not 'low'", async () => {
        capturedPriorities.length = 0;

        // A fresh, never-before-looked-up key so this doesn't just hit the
        // in-flight/peCache shortcut from the previous test.
        await getPeForInstrument("NSE_EQ|INE000C01003", "EQ");

        assert.ok(capturedPriorities.length >= 1);
        capturedPriorities.forEach((p) =>
            assert.strictEqual(p, undefined, "on-demand PE lookups (routes, backtests, buildRow) must not be deprioritized"),
        );
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
