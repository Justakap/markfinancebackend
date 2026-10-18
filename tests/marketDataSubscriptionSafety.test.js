/**
 * Grid Trading Simulator real-time integration — proves the additive,
 * reference-counted pin layer (pinInstrument/unpinInstrument) never
 * disrupts (or is disrupted by) subscribe()'s own watchlist-driven
 * full-set-replace, and that the two distinctly-named tick events
 * (tickEmitter "tick" vs. "fallbackTick") are each fired only from their
 * correct source. See ADR-022 in .claude/state/DECISIONS.md.
 *
 * No network/DB access: UPSTOX_ACCESS_TOKEN is left unset so connectFeed()
 * returns immediately (ws stays null), making sendSubscription()/
 * sendGroupedSubscriptions() safe in-memory no-ops — exactly the same
 * no-network-needed property tests/marketDataVolumeNull.test.js already
 * relies on. instrumentMeta is exposed specifically so tests can seed a
 * fake instrument without a real instrument-master fetch.
 */
const assert = require("assert");

process.env.UPSTOX_INSTRUMENT_MASTER_URL = "https://fake.test/market-data-subscription-safety-instruments.json";
delete process.env.UPSTOX_ACCESS_TOKEN;
delete process.env.UPSTOX_TOKEN;

const marketDataService = require("../services/marketDataService");
const {
    subscribe,
    pinInstrument,
    unpinInstrument,
    subscribedInstruments,
    liveData,
    instrumentMeta,
    tickEmitter,
    handleTick,
    broadcastLivePrices,
    primeInstrumentsCacheForTests,
} = marketDataService;

// Makes subscribe()'s internal applySubscription() run synchronously
// instead of deferring through a real (fake-URL, always-failing)
// loadInstruments() network call — see the export's doc comment.
primeInstrumentsCacheForTests([]);

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
        console.error(`    ${error.stack || error.message}`);
    }
}

function seedInstrument(key) {
    instrumentMeta.set(key, { symbol: key, name: key });
}

function resetState() {
    subscribedInstruments.clear();
    liveData.clear();
}

// --- pin/subscribe interaction ---

test("pinning an instrument does not require it to be in any watchlist", () => {
    resetState();
    seedInstrument("NSE_EQ|GRID1");
    pinInstrument("NSE_EQ|GRID1");
    assert.ok(!subscribedInstruments.has("NSE_EQ|GRID1")); // pins live in their own registry, not this set
    unpinInstrument("NSE_EQ|GRID1");
});

test("a watchlist subscribe() replacing its list never unsubscribes a pinned instrument", () => {
    resetState();
    seedInstrument("NSE_EQ|WATCH1");
    seedInstrument("NSE_EQ|GRID1");

    subscribe(["NSE_EQ|WATCH1", "NSE_EQ|GRID1"]); // both happen to be in the watchlist initially
    pinInstrument("NSE_EQ|GRID1"); // grid simulator also pins it

    // Watchlist is edited to drop GRID1 — this must NOT drop its live data
    // or disrupt the grid simulator's subscription to it.
    liveData.set("NSE_EQ|GRID1", { instrumentKey: "NSE_EQ|GRID1", ltp: 100, timestamp: Date.now() });
    subscribe(["NSE_EQ|WATCH1"]);

    assert.ok(liveData.has("NSE_EQ|GRID1"), "pinned instrument's live data must survive the watchlist drop");
    unpinInstrument("NSE_EQ|GRID1");
});

test("a watchlist subscribe() replacing its list still correctly unsubscribes a non-pinned instrument", () => {
    resetState();
    seedInstrument("NSE_EQ|WATCH1");
    seedInstrument("NSE_EQ|WATCH2");

    subscribe(["NSE_EQ|WATCH1", "NSE_EQ|WATCH2"]);
    liveData.set("NSE_EQ|WATCH2", { instrumentKey: "NSE_EQ|WATCH2", ltp: 50, timestamp: Date.now() });
    subscribe(["NSE_EQ|WATCH1"]);

    assert.ok(!liveData.has("NSE_EQ|WATCH2"), "an unpinned, dropped-from-watchlist instrument must still be cleaned up");
});

test("unpinning an instrument no watchlist wants anymore actually unsubscribes and cleans up", () => {
    resetState();
    seedInstrument("NSE_EQ|GRID2");
    pinInstrument("NSE_EQ|GRID2");
    liveData.set("NSE_EQ|GRID2", { instrumentKey: "NSE_EQ|GRID2", ltp: 10, timestamp: Date.now() });

    unpinInstrument("NSE_EQ|GRID2");
    assert.ok(!liveData.has("NSE_EQ|GRID2"));
});

test("unpinning an instrument a watchlist still wants does not clean up its live data", () => {
    resetState();
    seedInstrument("NSE_EQ|WATCH3");
    subscribe(["NSE_EQ|WATCH3"]);
    pinInstrument("NSE_EQ|WATCH3");
    liveData.set("NSE_EQ|WATCH3", { instrumentKey: "NSE_EQ|WATCH3", ltp: 10, timestamp: Date.now() });

    unpinInstrument("NSE_EQ|WATCH3");
    assert.ok(liveData.has("NSE_EQ|WATCH3"), "still wanted by the watchlist — must not be cleaned up");
    subscribe([]);
});

test("reference counting: an instrument pinned by two sessions stays subscribed until both unpin", () => {
    resetState();
    seedInstrument("NSE_EQ|SHARED");
    pinInstrument("NSE_EQ|SHARED"); // session A
    pinInstrument("NSE_EQ|SHARED"); // session B
    liveData.set("NSE_EQ|SHARED", { instrumentKey: "NSE_EQ|SHARED", ltp: 10, timestamp: Date.now() });

    unpinInstrument("NSE_EQ|SHARED"); // session A leaves
    assert.ok(liveData.has("NSE_EQ|SHARED"), "still pinned by session B");

    unpinInstrument("NSE_EQ|SHARED"); // session B leaves
    assert.ok(!liveData.has("NSE_EQ|SHARED"), "no pins left — now cleaned up");
});

// --- tick event source labeling ---

test('a genuine decoded WS tick (via the real handleTick) fires "tick", never "fallbackTick"', () => {
    resetState();
    seedInstrument("NSE_EQ|WSTICK");
    const received = { tick: [], fallbackTick: [] };
    const onTick = (t) => received.tick.push(t);
    const onFallback = (t) => received.fallbackTick.push(t);
    tickEmitter.on("tick", onTick);
    tickEmitter.on("fallbackTick", onFallback);

    try {
        handleTick({ instrumentKey: "NSE_EQ|WSTICK", ltp: 100, changeAmount: 1, changePercent: 1 });
        assert.strictEqual(received.tick.length, 1);
        assert.strictEqual(received.tick[0].instrumentKey, "NSE_EQ|WSTICK");
        assert.strictEqual(received.tick[0].ltp, 100);
        assert.strictEqual(received.fallbackTick.length, 0);
        assert.strictEqual(liveData.get("NSE_EQ|WSTICK").ltp, 100);
    } finally {
        tickEmitter.off("tick", onTick);
        tickEmitter.off("fallbackTick", onFallback);
    }
});

test("handleTick with no valid LTP (volume-only update) never emits a tick event", () => {
    resetState();
    seedInstrument("NSE_EQ|VOLONLY");
    let tickCount = 0;
    const onTick = () => {
        tickCount += 1;
    };
    tickEmitter.on("tick", onTick);
    try {
        handleTick({ instrumentKey: "NSE_EQ|VOLONLY", ltp: null, volume: 500 });
        assert.strictEqual(tickCount, 0);
    } finally {
        tickEmitter.off("tick", onTick);
    }
});

test('the real REST-fallback broadcast (broadcastLivePrices) fires only "fallbackTick", never "tick"', () => {
    resetState();
    seedInstrument("NSE_EQ|FALLBACK1");
    liveData.set("NSE_EQ|FALLBACK1", { instrumentKey: "NSE_EQ|FALLBACK1", ltp: 42, timestamp: Date.now() });

    const received = { tick: [], fallbackTick: [] };
    const onTick = (t) => received.tick.push(t);
    const onFallback = (t) => received.fallbackTick.push(t);
    tickEmitter.on("tick", onTick);
    tickEmitter.on("fallbackTick", onFallback);

    try {
        broadcastLivePrices(["NSE_EQ|FALLBACK1"]);
        assert.strictEqual(received.fallbackTick.length, 1);
        assert.strictEqual(received.fallbackTick[0].ltp, 42);
        assert.strictEqual(received.tick.length, 0);
    } finally {
        tickEmitter.off("tick", onTick);
        tickEmitter.off("fallbackTick", onFallback);
    }
});

console.log(`\nmarketDataService subscription-safety tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
