const assert = require("assert");

process.env.UPSTOX_ACCESS_TOKEN = "fake-token-for-tests";
process.env.UPSTOX_REQUEST_GAP_MS = "0";
process.env.UPSTOX_MAX_RETRIES = "2";
process.env.UPSTOX_RETRY_BASE_MS = "5";
process.env.UPSTOX_RETRY_MAX_MS = "10";
// Short TTL so the cache-expiry test doesn't need to wait long, but long
// enough that the cache-hit test (which runs immediately after a miss)
// never races it.
process.env.UPSTOX_OPTION_CHAIN_TTL_MS = "150";

const axios = require("axios");
const {
    isValidExpiryFormat,
    getOptionChain,
    getOptionExpiries,
    normalizeStrikeRow,
    normalizeLeg,
} = require("../services/optionChainService");
const { mapUpstreamError, createOptionChainRoutes } = require("../routes/optionChainRoutes");
const { requireAuth } = require("../middleware/auth");
const { enqueue } = require("../utils/upstoxRequestQueue");
const { strategyUsesPe } = require("../utils/backtestEngine");

let chainCallCount = 0;
let contractCallCount = 0;
let chainFailuresRemaining = 0;
let chainFailureStatus = 429;
let nextChainData = null;

function sampleStrikeRow(overrides = {}) {
    return {
        strike_price: 18700,
        call_options: {
            instrument_key: "NSE_FO|CE123",
            market_data: {
                ltp: 22.45,
                volume: 1234,
                oi: 123456,
                prev_oi: 120000,
                bid_price: 22,
                ask_price: 22.5,
            },
            option_greeks: {
                iv: 14.5,
                delta: 0.45,
                gamma: 0.001,
                theta: -9.5,
                vega: 5.47,
                pop: 45.2,
            },
        },
        put_options: {
            instrument_key: "NSE_FO|PE123",
            market_data: {
                ltp: 18.1,
                volume: 987,
                oi: 65000,
                prev_oi: 70000,
                bid_price: 17.9,
                ask_price: 18.3,
            },
            option_greeks: {
                iv: 15.1,
                delta: -0.4,
                gamma: 0.0012,
                theta: -8.2,
                vega: 5.1,
                pop: 38.9,
            },
        },
        ...overrides,
    };
}

const originalAxiosGet = axios.get.bind(axios);
axios.get = (url, config) => {
    if (url.includes("/option/chain")) {
        chainCallCount += 1;

        if (chainFailuresRemaining > 0) {
            chainFailuresRemaining -= 1;
            const error = new Error(`simulated ${chainFailureStatus}`);
            error.response = { status: chainFailureStatus, headers: {} };
            error.request = {};
            return Promise.reject(error);
        }

        return Promise.resolve({ data: { data: nextChainData ?? [sampleStrikeRow()] } });
    }

    if (url.includes("/option/contract")) {
        contractCallCount += 1;
        return Promise.resolve({
            data: {
                data: [
                    { expiry: "2026-10-30" },
                    { expiry: "2026-10-23" },
                    { expiry: "2026-10-30" },
                ],
            },
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

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function fakeRes() {
    return {
        statusCode: null,
        body: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(payload) {
            this.body = payload;
            return this;
        },
    };
}

/** Grabs a route's final (post-middleware) async handler without needing a
 *  real HTTP server/supertest — consistent with this repo's function-level
 *  test convention (no HTTP-layer test harness exists here). */
function finalHandlerFor(router, path) {
    const layer = router.stack.find((l) => l.route?.path === path);
    const stack = layer.route.stack;
    return { middlewares: stack.slice(0, -1).map((l) => l.handle), handle: stack.at(-1).handle };
}

(async () => {
    console.log("Option chain service — mapping, validation, cache, dedup, queue reuse\n");

    // --- Mapping correctness (tests 1-7) ---

    await test("1. Valid option-chain request returns normalized structure", async () => {
        chainCallCount = 0;
        nextChainData = [sampleStrikeRow()];
        const result = await getOptionChain("NSE_INDEX|Nifty 50", "2026-10-30");

        assert.strictEqual(result.underlying, "NSE_INDEX|Nifty 50");
        assert.strictEqual(result.expiry, "2026-10-30");
        assert.strictEqual(result.strikes.length, 1);
    });

    await test("2. Correct CE mapping", () => {
        const row = normalizeStrikeRow(sampleStrikeRow());
        assert.strictEqual(row.CE.instrumentKey, "NSE_FO|CE123");
        assert.strictEqual(row.CE.ltp, 22.45);
    });

    await test("3. Correct PE mapping", () => {
        const row = normalizeStrikeRow(sampleStrikeRow());
        assert.strictEqual(row.PE.instrumentKey, "NSE_FO|PE123");
        assert.strictEqual(row.PE.ltp, 18.1);
    });

    await test("4. Correct strike mapping", () => {
        const row = normalizeStrikeRow(sampleStrikeRow({ strike_price: 19000 }));
        assert.strictEqual(row.strike, 19000);
    });

    await test("5. Correct LTP/OI/volume/OI-change mapping", () => {
        const row = normalizeStrikeRow(sampleStrikeRow());
        assert.strictEqual(row.CE.volume, 1234);
        assert.strictEqual(row.CE.oi, 123456);
        assert.strictEqual(row.CE.previousOi, 120000);
        assert.strictEqual(row.CE.oiChange, 3456);
        assert.strictEqual(row.PE.oiChange, -5000);
    });

    await test("6. Correct bid/ask mapping", () => {
        const row = normalizeStrikeRow(sampleStrikeRow());
        assert.strictEqual(row.CE.bid, 22);
        assert.strictEqual(row.CE.ask, 22.5);
    });

    await test("7. Correct IV/Delta/Gamma/Theta/Vega/PoP mapping", () => {
        const row = normalizeStrikeRow(sampleStrikeRow());
        assert.strictEqual(row.CE.iv, 14.5);
        assert.strictEqual(row.CE.delta, 0.45);
        assert.strictEqual(row.CE.gamma, 0.001);
        assert.strictEqual(row.CE.theta, -9.5);
        assert.strictEqual(row.CE.vega, 5.47);
        assert.strictEqual(row.CE.pop, 45.2);
    });

    await test("8. Missing optional fields produce nulls, no throw", () => {
        const row = normalizeStrikeRow({
            strike_price: 18700,
            call_options: { instrument_key: "NSE_FO|CE999" },
            put_options: null,
        });

        assert.strictEqual(row.CE.ltp, null);
        assert.strictEqual(row.CE.oiChange, null);
        assert.strictEqual(row.PE, null);
        assert.deepStrictEqual(normalizeLeg(undefined), null);
    });

    // --- Validation (tests 9-12) ---

    await test("9. Invalid instrument key is rejected by the route (400)", async () => {
        const fakeUpstox = { isValidInstrumentKey: () => false };
        const router = createOptionChainRoutes({
            requireAuth,
            optionChainLimiter: (req, res, next) => next(),
            upstoxMarketData: fakeUpstox,
            getOptionChain,
            getOptionExpiries,
            isValidExpiryFormat,
        });
        const { handle } = finalHandlerFor(router, "/option-chain");
        const req = { query: { instrumentKey: "garbage", expiry: "2026-10-30" } };
        const res = fakeRes();

        await handle(req, res);

        assert.strictEqual(res.statusCode, 400);
        assert.match(res.body.message, /Invalid instrumentKey/);
    });

    await test("10. Missing instrument key is rejected by the route (400)", async () => {
        const router = createOptionChainRoutes({
            requireAuth,
            optionChainLimiter: (req, res, next) => next(),
            upstoxMarketData: { isValidInstrumentKey: () => true },
            getOptionChain,
            getOptionExpiries,
            isValidExpiryFormat,
        });
        const { handle } = finalHandlerFor(router, "/option-chain");
        const req = { query: { expiry: "2026-10-30" } };
        const res = fakeRes();

        await handle(req, res);

        assert.strictEqual(res.statusCode, 400);
        assert.match(res.body.message, /instrumentKey is required/);
    });

    await test("11. Invalid expiry format is rejected (400)", () => {
        assert.strictEqual(isValidExpiryFormat("30-10-2026"), false);
        assert.strictEqual(isValidExpiryFormat("2026-13-99"), false);
        assert.strictEqual(isValidExpiryFormat(""), false);
        assert.strictEqual(isValidExpiryFormat("2026-10-30"), true);
    });

    await test("12. Missing expiry is rejected by the route (400)", async () => {
        const router = createOptionChainRoutes({
            requireAuth,
            optionChainLimiter: (req, res, next) => next(),
            upstoxMarketData: { isValidInstrumentKey: () => true },
            getOptionChain,
            getOptionExpiries,
            isValidExpiryFormat,
        });
        const { handle } = finalHandlerFor(router, "/option-chain");
        const req = { query: { instrumentKey: "NSE_INDEX|Nifty 50" } };
        const res = fakeRes();

        await handle(req, res);

        assert.strictEqual(res.statusCode, 400);
        assert.match(res.body.message, /expiry is required/);
    });

    // --- Empty / malformed upstream responses (tests 13-14) ---

    await test("13. Empty option-chain response yields strikes: []", async () => {
        nextChainData = [];
        const result = await getOptionChain("NSE_INDEX|Nifty 50", "2026-11-05");
        assert.deepStrictEqual(result.strikes, []);
    });

    await test("14. Malformed Upstox response (non-array data) yields strikes: [], no throw", async () => {
        nextChainData = { unexpected: "shape" };
        const result = await getOptionChain("NSE_INDEX|Nifty 50", "2026-11-12");
        assert.deepStrictEqual(result.strikes, []);
        nextChainData = null;
    });

    // --- Authentication (test 15) ---

    await test("15. Both routes enforce requireAuth before any handler logic", () => {
        const router = createOptionChainRoutes({
            requireAuth,
            optionChainLimiter: (req, res, next) => next(),
            upstoxMarketData: { isValidInstrumentKey: () => true },
            getOptionChain,
            getOptionExpiries,
            isValidExpiryFormat,
        });

        const chain = finalHandlerFor(router, "/option-chain");
        const expiries = finalHandlerFor(router, "/option-chain/expiries");

        assert.strictEqual(chain.middlewares[0], requireAuth);
        assert.strictEqual(expiries.middlewares[0], requireAuth);
    });

    await test("15b. requireAuth itself rejects a request with no token (401)", () => {
        const res = fakeRes();
        let nextCalled = false;
        requireAuth({ headers: {} }, res, () => {
            nextCalled = true;
        });

        assert.strictEqual(res.statusCode, 401);
        assert.strictEqual(nextCalled, false);
    });

    // --- Upstox transient-error retry behavior (tests 16-17) ---

    await test("16. Upstox 429 is retried (via the existing queue) and eventually succeeds", async () => {
        chainCallCount = 0;
        chainFailuresRemaining = 2;
        chainFailureStatus = 429;
        nextChainData = [sampleStrikeRow()];

        const result = await getOptionChain("NSE_INDEX|Nifty 50", "2026-12-24");

        assert.strictEqual(chainCallCount, 3, "expected 2 failures + 1 success = 3 calls");
        assert.strictEqual(result.strikes.length, 1);
    });

    await test("17. Upstox 5xx is retried (via the existing queue) and eventually succeeds", async () => {
        chainCallCount = 0;
        chainFailuresRemaining = 2;
        chainFailureStatus = 503;
        nextChainData = [sampleStrikeRow()];

        const result = await getOptionChain("NSE_INDEX|Nifty 50", "2027-01-28");

        assert.strictEqual(chainCallCount, 3);
        assert.strictEqual(result.strikes.length, 1);
    });

    await test("17b. mapUpstreamError never surfaces Upstox 401/403 as a client 401/403", () => {
        const err401 = { response: { status: 401 } };
        const err403 = { response: { status: 403 } };
        const err429 = { response: { status: 429 } };
        const err503 = { response: { status: 503 } };

        assert.strictEqual(mapUpstreamError(err401).status, 503);
        assert.strictEqual(mapUpstreamError(err403).status, 503);
        assert.strictEqual(mapUpstreamError(err429).status, 429);
        assert.strictEqual(mapUpstreamError(err503).status, 503);
    });

    // --- Dedup / cache (tests 18-20) ---

    await test("18. 5 identical concurrent requests cause exactly 1 Upstox call", async () => {
        chainCallCount = 0;
        chainFailuresRemaining = 0;
        nextChainData = [sampleStrikeRow()];
        const key = "NSE_INDEX|Nifty 50";
        const expiry = "2026-09-17"; // fresh key, not reused by earlier tests

        const results = await Promise.all([
            getOptionChain(key, expiry),
            getOptionChain(key, expiry),
            getOptionChain(key, expiry),
            getOptionChain(key, expiry),
            getOptionChain(key, expiry),
        ]);

        assert.strictEqual(chainCallCount, 1);
        results.forEach((r) => assert.deepStrictEqual(r, results[0]));
    });

    await test("19. Cache hit avoids a second Upstox request", async () => {
        chainCallCount = 0;
        const key = "NSE_INDEX|Nifty 50";
        const expiry = "2026-09-17"; // same key as test 18 — still warm in cache

        await getOptionChain(key, expiry);

        assert.strictEqual(chainCallCount, 0, "expected the cache to serve this without a new Upstox call");
    });

    await test("20. Cache expiry causes a fresh Upstox request", async () => {
        chainCallCount = 0;
        const key = "NSE_INDEX|Nifty 50";
        const expiry = "2026-09-17";

        await sleep(200); // > UPSTOX_OPTION_CHAIN_TTL_MS (150ms)
        await getOptionChain(key, expiry);

        assert.strictEqual(chainCallCount, 1, "expected the expired cache entry to trigger exactly one fresh call");
    });

    await test("20b. getOptionExpiries dedupes/caches contract lookups and sorts unique expiries", async () => {
        contractCallCount = 0;
        const [a, b] = await Promise.all([
            getOptionExpiries("NSE_INDEX|Nifty 50"),
            getOptionExpiries("NSE_INDEX|Nifty 50"),
        ]);

        assert.strictEqual(contractCallCount, 1);
        assert.deepStrictEqual(a, ["2026-10-23", "2026-10-30"]);
        assert.deepStrictEqual(b, a);
    });

    // --- Existing infra regression (tests 21-22) ---

    await test("21. Existing Upstox queue concurrency is still bounded at 3", async () => {
        const TASK_MS = 20;
        let active = 0;
        let activePeak = 0;

        const makeTask = () => async () => {
            active += 1;
            activePeak = Math.max(activePeak, active);
            await sleep(TASK_MS);
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

        assert.strictEqual(activePeak, 3, "option-chain's route to the shared queue must not change its concurrency cap");
    });

    await test("22. Existing PE historical-backtest validation is unaffected by this phase's changes", () => {
        assert.strictEqual(
            strategyUsesPe({
                entryConditions: [{ indicator: "PE Ratio", operator: "<", compareType: "value", value: "20" }],
                exitConditions: [],
            }),
            true,
        );
        assert.strictEqual(
            strategyUsesPe({
                entryConditions: [{ indicator: "RSI (Daily)", operator: "<", compareType: "value", value: "30" }],
                exitConditions: [],
            }),
            false,
        );
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
