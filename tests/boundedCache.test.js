const assert = require("assert");
const { createBoundedCache } = require("../utils/boundedCache");

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        passed += 1;
        console.log(`  ✓ ${name}`);
    } catch (error) {
        failed += 1;
        console.error(`  ✗ ${name}`);
        console.error(`    ${error.message}`);
    }
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

(async () => {
    console.log("Bounded cache — TTL + max size\n");

    test("get/set round-trips a value", () => {
        const cache = createBoundedCache({ maxSize: 10 });
        cache.set("a", 1);
        assert.strictEqual(cache.get("a"), 1);
        cache.stopSweep();
    });

    test("max size evicts the oldest entry, never the newest", () => {
        const cache = createBoundedCache({ maxSize: 3 });
        cache.set("a", 1);
        cache.set("b", 2);
        cache.set("c", 3);
        cache.set("d", 4); // should evict "a"

        assert.strictEqual(cache.get("a"), undefined, "oldest entry should be evicted");
        assert.strictEqual(cache.get("d"), 4, "newest entry must survive");
        assert.strictEqual(cache.size, 3);
        cache.stopSweep();
    });

    test("re-setting a key refreshes its position (not evicted next)", () => {
        const cache = createBoundedCache({ maxSize: 2 });
        cache.set("a", 1);
        cache.set("b", 2);
        cache.set("a", "updated"); // touch "a" again, "b" is now oldest
        cache.set("c", 3); // should evict "b", not "a"

        assert.strictEqual(cache.get("a"), "updated");
        assert.strictEqual(cache.get("b"), undefined);
        assert.strictEqual(cache.get("c"), 3);
        cache.stopSweep();
    });

    await test("TTL expires an entry on read", async () => {
        const cache = createBoundedCache({ maxSize: 10, ttlMs: 20 });
        cache.set("a", 1);
        assert.strictEqual(cache.get("a"), 1);
        await sleep(30);
        assert.strictEqual(cache.get("a"), undefined, "entry should have expired");
        cache.stopSweep();
    });

    await test("background sweep removes expired entries without being read", async () => {
        const cache = createBoundedCache({ maxSize: 10, ttlMs: 10, sweepIntervalMs: 20 });
        cache.set("a", 1);
        await sleep(50);
        const removed = cache.sweep();
        assert.ok(removed >= 0);
        assert.strictEqual(cache.get("a"), undefined);
        cache.stopSweep();
    });

    test("delete() removes an entry immediately", () => {
        const cache = createBoundedCache({ maxSize: 10 });
        cache.set("a", 1);
        cache.delete("a");
        assert.strictEqual(cache.get("a"), undefined);
        cache.stopSweep();
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
