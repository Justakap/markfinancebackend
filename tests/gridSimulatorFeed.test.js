/**
 * Grid Trading Simulator — tests for services/gridSimulatorFeed.js (price
 * sourcing/staleness, not the crossing engine itself — see
 * gridSimulatorEngine.test.js for that). Mocks marketDataService and
 * processTick via dependency injection, same convention as
 * liveStrategyOrchestrator.test.js mocking fetchLatestClosedCandles.
 */
const assert = require("assert");
const mongoose = require("mongoose");

const { pollAllActiveSessions, STALE_THRESHOLD_MS } = require("../services/gridSimulatorFeed");

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
        console.error(`    ${error.stack || error.message}`);
    }
}

function makeSessionDoc(overrides = {}) {
    return { _id: new mongoose.Types.ObjectId(), status: "ACTIVE", instrumentKey: "NSE_EQ|A", ...overrides };
}

function makeFakeSessionModel(docs) {
    const updates = [];
    return {
        updates,
        async find(filter = {}) {
            return docs.filter((d) => (filter.status ? d.status === filter.status : true));
        },
        async findOneAndUpdate(filter, update) {
            updates.push({ filter, update });
            return null;
        },
    };
}

(async () => {
    await test("a fresh live price is forwarded to processTick with the correct price/timestamp", async () => {
        const session = makeSessionDoc();
        const GridSimulatorSession = makeFakeSessionModel([session]);
        const now = Date.now();
        const marketDataService = {
            warmLiveQuotes: async () => {},
            liveData: new Map([[session.instrumentKey, { ltp: 123.45, timestamp: now }]]),
        };
        const calls = [];
        const processTick = async (args) => {
            calls.push(args);
            return { skipped: false, trades: [] };
        };

        const results = await pollAllActiveSessions({ GridSimulatorSession, GridSimulatorTrade: {}, marketDataService, processTick });
        assert.strictEqual(calls.length, 1);
        assert.strictEqual(calls[0].price, 123.45);
        assert.strictEqual(results[0].skipped, false);
    });

    await test("missing live data is reported as NO_DATA and never fabricated into a tick", async () => {
        const session = makeSessionDoc();
        const GridSimulatorSession = makeFakeSessionModel([session]);
        const marketDataService = { warmLiveQuotes: async () => {}, liveData: new Map() };
        let called = false;
        const processTick = async () => {
            called = true;
        };

        const results = await pollAllActiveSessions({ GridSimulatorSession, GridSimulatorTrade: {}, marketDataService, processTick });
        assert.strictEqual(called, false);
        assert.strictEqual(results[0].reason, "no_data");
        const feedUpdate = GridSimulatorSession.updates.find((u) => u.update.$set.lastFeedStatus === "NO_DATA");
        assert.ok(feedUpdate);
    });

    await test("a stale timestamp is never treated as live, even if an ltp value is present", async () => {
        const session = makeSessionDoc();
        const GridSimulatorSession = makeFakeSessionModel([session]);
        const staleTimestamp = Date.now() - (STALE_THRESHOLD_MS + 10_000);
        const marketDataService = {
            warmLiveQuotes: async () => {},
            liveData: new Map([[session.instrumentKey, { ltp: 99, timestamp: staleTimestamp }]]),
        };
        let called = false;
        const processTick = async () => {
            called = true;
        };

        const results = await pollAllActiveSessions({ GridSimulatorSession, GridSimulatorTrade: {}, marketDataService, processTick });
        assert.strictEqual(called, false);
        assert.strictEqual(results[0].reason, "stale");
    });

    await test("one session's failure is isolated and does not stop the rest of the fleet", async () => {
        const good = makeSessionDoc({ instrumentKey: "NSE_EQ|GOOD" });
        const bad = makeSessionDoc({ instrumentKey: "NSE_EQ|BAD" });
        const GridSimulatorSession = makeFakeSessionModel([bad, good]);
        const now = Date.now();
        const marketDataService = {
            warmLiveQuotes: async () => {},
            liveData: new Map([
                [good.instrumentKey, { ltp: 100, timestamp: now }],
                [bad.instrumentKey, { ltp: 100, timestamp: now }],
            ]),
        };
        const processTick = async ({ sessionId }) => {
            if (String(sessionId) === String(bad._id)) throw new Error("boom");
            return { skipped: false, trades: [] };
        };

        const results = await pollAllActiveSessions({ GridSimulatorSession, GridSimulatorTrade: {}, marketDataService, processTick });
        const goodResult = results.find((r) => String(r.sessionId) === String(good._id));
        const badResult = results.find((r) => String(r.sessionId) === String(bad._id));
        assert.strictEqual(goodResult.skipped, false);
        assert.strictEqual(badResult.skipped, true);
        assert.strictEqual(badResult.reason, "error");
    });

    await test("a throwing warmLiveQuotes does not abort the whole poll cycle", async () => {
        const session = makeSessionDoc();
        const GridSimulatorSession = makeFakeSessionModel([session]);
        const marketDataService = {
            warmLiveQuotes: async () => {
                throw new Error("Upstox down");
            },
            liveData: new Map(), // nothing warmed, so this session correctly reports no_data
        };
        let called = false;
        const processTick = async () => {
            called = true;
        };

        const results = await pollAllActiveSessions({ GridSimulatorSession, GridSimulatorTrade: {}, marketDataService, processTick });
        assert.strictEqual(called, false);
        assert.strictEqual(results[0].reason, "no_data"); // did not crash; degraded gracefully
    });

    console.log(`\nGrid simulator feed tests: ${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
