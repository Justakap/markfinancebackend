# CLAUDE.md — MarkFinance Backend

This file is persistent context for any Claude Code session working in this
repository. Read it fully before making changes, especially before touching
authentication, authorization, CORS, or the Upstox market-data services.

## Project Overview

MarkFinance is a stock-market analysis, strategy-building, and backtesting
web application. Users track watchlists of NSE/BSE (and some F&O) instruments,
build rule-based strategies, scan watchlists against those strategies, and
run historical backtests — all backed by live and historical data from
Upstox.

## Repository

This repository (`markfinancebackend`) is the **backend only**: a Node.js/
Express API + Socket.IO server. The frontend lives in a separate repository,
`markfinance` (see Repository URLs below).

## Architecture

- **Framework:** Express 5, single entry point `app.js` (routes + bootstrap).
- **Database:** MongoDB via Mongoose. Models: `User`, `Watchlist`, `Strategy`,
  `Backtest` (see `models/`). There is no `Stock` model anymore — it was
  unused scaffolding and was removed.
- **Authentication:** Firebase Google OAuth is verified on the **frontend**;
  the backend never talks to Firebase. The frontend sends `{uid, name, email,
  photoURL}` to `POST /api/auth/google`, the backend upserts a `User` by
  `googleId`/`email` and issues its own JWT (`config/jwt.js`,
  `middleware/auth.js`). All protected routes require `Authorization: Bearer
  <jwt>` via `requireAuth`.
- **Services** (`services/`):
  - `marketDataService.js` — Upstox REST + protobuf WebSocket feed client,
    live tick state, indicator refresh loops, instrument search/master cache,
    Socket.IO emission (`marketTick` events).
  - `fundamentalService.js` — PE ratio lookups (Upstox fundamentals API),
    cached.
  - `candleService.js` — historical/intraday candle fetching, merges
    historical + intraday, used by backtests and indicators.
  - `instrumentIndicatorBundle.js` — multi-timeframe candle bundles + derived
    indicators (RSI/EMA/VWAP/etc), cached per instrument.
  - `strategyScanService.js` — evaluates a strategy against a watchlist's
    live data.
- **Upstox REST request queue & caching** (`utils/`) — see "Market Data"
  below; **do not bypass or replace this without reading that section.**
- **Socket.IO:** one shared server instance (`io`), origin-restricted to the
  configured allowlist (`config/cors.js`), emits `marketTick` per instrument
  tick. No per-user rooms — all connected clients receive all ticks for
  subscribed instruments (this is a single/small-tenant app, not built for
  large multi-tenant fan-out).

## Production

- Frontend: https://markfinance.netlify.app
- Backend: https://markfinancebackend1.onrender.com (Render free tier — expect
  a ~20-30s cold start after idle; this is a platform characteristic, not a
  bug)

## Repository URLs

- Frontend: https://github.com/Justakap/markfinance
- Backend: https://github.com/Justakap/markfinancebackend

## Authentication

Flow: **Firebase Google OAuth (frontend) → `POST /api/auth/google` → backend
JWT → frontend `localStorage`.**

- The backend trusts `uid`/`email` from the request body for the *initial*
  login exchange only (validated to be non-empty strings) — this is the one
  place client-supplied identity is accepted, because it's what establishes
  identity in the first place. Every route *after* login uses the JWT's
  `mongoId`, never a client-supplied id.
- JWT: `jsonwebtoken`, `HS256`, 7-day expiry, secret from `JWT_SECRET`
  (`config/jwt.js` — the process refuses to boot if this is unset).
- `middleware/auth.js`'s `requireAuth` verifies the token and sets
  `req.user = { mongoId, name, email }`. Every protected route uses
  `req.user.mongoId` as the source of truth for ownership — see Security
  Rules below.
- 401 vs 403: `requireAuth` itself returns 401 for missing/invalid/expired
  tokens. Routes return 403 only where a client-supplied id (e.g.
  `/api/strategies/:userId`) doesn't match the authenticated user — everywhere
  else, "not yours" is a 404 (see Security Rules — this is intentional, not
  an oversight).
- Logout is frontend-only (clears `localStorage`); there is no server-side
  token revocation/blocklist. A leaked token is valid until it expires (7
  days) or `JWT_SECRET` is rotated.

## Market Data

**Do not replace or bypass this architecture without reading all of this
section first — it was built specifically to solve recurring Upstox 429
(rate limit) errors.**

- `utils/upstoxRequestQueue.js` — every Upstox REST call should go through
  `enqueue(() => axios...)`. It serializes calls with a minimum gap
  (`UPSTOX_REQUEST_GAP_MS`), and on 429/502/503/504/timeout it retries with
  exponential backoff + jitter, honoring `Retry-After` when present, bounded
  by `UPSTOX_MAX_RETRIES` (default 3). It never retries permanent 4xx errors
  (400/401/403/404). Covered by `tests/upstoxRequestQueue.test.js`.
  - **Priority lanes:** `enqueue(task, { priority: "critical" })` jumps ahead
    of the (default) `"background"` lane's backlog — it does not interrupt a
    task already in flight, and both lanes share the same throttle clock, so
    the combined Upstox call rate is unchanged; only ordering changes.
    `marketDataService.warmLiveQuotes()` (the LTP lookup that blocks
    `GET /api/market-data/:id`'s response) uses `"critical"`. Candle fetches
    (`candleService.js`) and PE lookups (`fundamentalService.js`) stay on the
    default background lane since they feed indicators asynchronously and
    don't block any user-facing response. This fixes "add stock"/RSI-DMA
    population feeling slow when a watchlist refresh queues dozens of candle
    fetches ahead of a live-price lookup — see Change History below.
- `utils/requestDedup.js` — collapses concurrent identical in-flight requests
  to one underlying call (used by `candleService.getCandles`).
- Caching (all via `utils/boundedCache.js` — TTL + max-size + LRU eviction,
  see Current Technical Debt / cache docs below for specifics):
  `fundamentalService`'s PE cache, `marketDataService`'s instrument-search
  cache, `instrumentKeyResolver`'s invalid-key cache.
- `liveData`/`indicatorSnapshot` in `marketDataService.js` are **not** TTL
  caches — they're live state for currently-subscribed instruments, pruned
  the moment an instrument is unsubscribed (see `subscribe()`), with a
  defensive size backstop (`pruneLiveDataIfOversized`).
- The Upstox WebSocket feed (protobuf, `proto/MarketDataFeedV3.proto`) is the
  primary live-tick source; a REST LTP poll (`startLtpPollLoop`) is a
  fallback only when the socket is down. **WS ticks do not go through
  `upstoxRequestQueue`** — that queue is for REST calls only, intentionally.
- 429 handling is "solved" at the single-process level. It is **not**
  distributed — if you ever run multiple backend instances, the queue's
  in-memory state (and all the caches above) are per-process and not shared.

## Security Rules

These are hard rules, not suggestions — violating them reintroduces the exact
class of bug this hardening pass fixed:

1. **Every user-owned resource query must be scoped to the authenticated
   user**, in the query itself: `Model.findOne({ _id: id, userId:
   req.user.mongoId })`, never `Model.findById(id)` followed by a separate
   ownership check.
2. **Never trust a client-supplied `userId`** for authorization — always use
   `req.user.mongoId` from the verified JWT. Routes that accept a `:userId`
   path param (`/api/strategies/:userId`, `/api/backtests/:userId`) only use
   it as a legacy-compatible echo check (`param !== req.user.mongoId → 403`);
   the actual query always filters by `req.user.mongoId`.
3. **Never skip an ownership check because `userId` is null/undefined.** A
   resource with no owner is nobody's — treat it as not found (404), not as
   accessible. (This exact bug — `if (resource.userId && !ownsResource(...))`
   — was the main IDOR vulnerability fixed in this pass. Don't reintroduce
   it.)
4. A missing/malformed resource should return **404** regardless of whether
   it doesn't exist or belongs to someone else — don't leak which case it is.
   **A malformed Mongo ObjectId should return 400**, via the
   `validateObjectId(...paramNames)` middleware (`middleware/
   validateObjectId.js`) — apply it to every route with an ObjectId path
   param, and validate body-supplied ids (e.g. `strategyId` in
   `/api/strategies/run`) inline with `mongoose.Types.ObjectId.isValid()`.
5. **Production CORS must never be a wildcard.** Origins are allowlisted in
   `config/cors.js` (`isOriginAllowed`), defaulting to
   `https://markfinance.netlify.app` plus localhost when not in production.
   Socket.IO uses the same allowlist. If you need to add an origin, update
   `config/cors.js` or set `ALLOWED_ORIGINS`/`FRONTEND_URL` — don't fall back
   to `"*"`.
6. **Debug/validation endpoints must stay protected.** `/api/debug/:symbol`
   and `/api/validation/*` require both `requireAuth` AND `VALIDATION_MODE`
   (off by default when `NODE_ENV=production` unless
   `ENABLE_VALIDATION_MODE=true`). The old unauthenticated `/test` route was
   deleted — don't re-add a debug route without the same two gates.
7. **Never return raw internal errors to clients.** Every catch block logs
   the full error server-side (`console.error`) and returns a short, generic
   message. The centralized `middleware/errorHandler.js` is a last-resort net
   for anything that reaches `next(err)` or an unmatched route — it is not a
   substitute for each route's own safe error message.
8. **Never log secrets or tokens** (JWT, `UPSTOX_ACCESS_TOKEN`, `MONGO_URI`
   credentials). Logging error messages/stacks server-side is fine; logging
   `req.headers.authorization` or any token value is not.
9. **Rate limiting:** `/api/auth/google` (`authLimiter`) and
   `/api/backtest/run` (`backtestLimiter`) have dedicated `express-rate-limit`
   instances; all other mutating `/api/*` routes get a generous
   `writeLimiter` safety net (`app.use("/api", writeLimiter)`, skips GET).
   `/api/search` and `/api/market-data/:id` use the older hand-rolled
   `rateLimit()`/`searchRateLimit()` in `app.js` (kept for its debounce-sized
   limits) — it now self-prunes stale IP entries every 5 minutes.
10. All protected endpoints must use `requireAuth`. If you add a new route
    that touches user data, add it.

## Important API Rules

Don't rename or change the shape of these without checking the frontend
(`markfinance` repo) — it hard-codes these paths/shapes:

- `POST /api/auth/google` → `{ success, user, token }`
- `GET /api/watchlists?userId=...` → array of watchlists (the `userId` query
  param is accepted for backward compatibility but ignored — the response is
  always scoped to the authenticated user)
- `GET /api/watchlists/:id`, `PUT`, `DELETE`, `POST /:id/stocks`,
  `DELETE /:id/stocks/:symbol`, `POST /:id/stocks/bulk-remove`,
  `POST /:id/refresh-fundamentals`
- `GET /api/strategies/:userId`, `POST /api/strategies`, `PUT
  /api/strategies/:id`, `DELETE /api/strategies/:id`, `POST
  /api/strategies/run`, `POST /api/strategies/seed-samples`, `GET
  /api/strategy-details/:id`
- `POST /api/backtest/run`, `GET /api/backtests/:userId`, `GET
  /api/backtests/detail/:id`, `DELETE /api/backtests/:id`
- `GET /api/market-data/:watchlistId`, `GET /api/search?q=`, `GET
  /api/search-stock?q=` (legacy alias, same handler)
- `GET /api/dashboard`, `GET /api/metrics`, `GET /api/health`
- **Socket.IO:** the only event currently emitted is `marketTick` (per-tick,
  one event per instrument, not batched). The frontend's `socket.js` also
  listens for a legacy `batchedStockUpdates` event (`onBatchedStockUpdates`,
  `onStockUpdate`) that **the backend does not currently emit** — this is
  dead wiring left over from an earlier batching design. Don't assume it's
  live; if you want real batching, you'd need to add the emit on the backend
  side and verify the frontend consumers still expect the same payload shape.

## Environment Variables

Names only — see `.env.example` for the full annotated list, never commit
real values:

- `MONGO_URI` — MongoDB connection string (required, process exits without
  it)
- `JWT_SECRET` — JWT signing secret (required, process exits without it)
- `PORT` — HTTP port (default 5001)
- `NODE_ENV` — `production` enables stricter CORS defaults and disables
  debug/validation routes unless `ENABLE_VALIDATION_MODE=true`
- `UPSTOX_ACCESS_TOKEN` (or legacy `UPSTOX_TOKEN`) — Upstox API token
- `UPSTOX_INSTRUMENT_MASTER_URL` — override for the instrument master feed
- `ALLOWED_ORIGINS` / `FRONTEND_URL` — comma-separated CORS allowlist override
- `ENABLE_VALIDATION_MODE` — force-enable debug/validation routes outside dev
- `UPSTOX_REQUEST_GAP_MS`, `UPSTOX_MAX_RETRIES`, `UPSTOX_RETRY_BASE_MS`,
  `UPSTOX_RETRY_MAX_MS` — request queue tuning
- `UPSTOX_LTP_POLL_MS`, `UPSTOX_WS_RECONNECT_MS`,
  `UPSTOX_INDICATOR_REFRESH_MS` — live feed timing
- `UPSTOX_FEED_MODE`, `UPSTOX_FUTURES_FEED_MODE`, `UPSTOX_OPTION_FEED_MODE` —
  Upstox WS subscription modes
- `UPSTOX_PE_TTL_MS`, `UPSTOX_PE_CACHE_MAX_SIZE`,
  `UPSTOX_SEARCH_CACHE_MAX_SIZE`, `UPSTOX_INVALID_KEY_CACHE_MAX_SIZE`,
  `UPSTOX_LIVE_DATA_MAX_SIZE` — cache sizing/TTL
- `INDICATOR_BUNDLE_MAX_AGE_MS` — indicator bundle cache age
- `BACKTEST_COMMISSION_PCT`, `BACKTEST_SLIPPAGE_PCT` — backtest engine tuning

## Development

```bash
npm install          # install dependencies
npm start             # start the server (node app.js), needs backend/.env
npm test               # run all test suites (evaluator, request queue, bounded cache)
npm run validate       # run utils/validationService.js directly
```

No separate lint script is configured in this repo.

## Testing

- `tests/evaluator.test.js` — strategy condition evaluation logic (crosses
  above/below, AND/OR logic).
- `tests/upstoxRequestQueue.test.js` — the hardened request queue: normal
  request, dedup, 429 with/without `Retry-After`, repeated 429 past max
  retries, permanent 400/401/403 not retried, timeout retried, queue survives
  a permanent failure.
- `tests/boundedCache.test.js` — TTL expiry, max-size LRU eviction, re-set
  refreshing position, background sweep, manual delete.
- No integration test harness exists; manual regression (real two-user IDOR
  testing, live Upstox calls) was done ad hoc against a local server with the
  real `.env` during this hardening pass and is not automated. If you add
  integration tests, prefer hitting a local server with disposable test
  users/data and clean up afterward — this is a shared production MongoDB
  Atlas cluster, not a disposable test DB.

## Deployment

- **Backend → Render**, auto-deploys from this repository's `main` branch
  (service at https://markfinancebackend1.onrender.com). This repository does
  not control the frontend's Netlify deployment.
- Render env vars (Mongo URI, JWT secret, Upstox token, CORS overrides) are
  configured in the Render dashboard, not in this repo.

## Git Workflow

1. Always inspect `git status`, `git branch`, and `git log` first.
2. Never discard existing uncommitted changes without understanding them —
   they may be another session's or the user's in-progress work.
3. Never force-push.
4. Never `git reset --hard` unless explicitly requested.
5. Never commit secrets — double-check `git diff` for `.env` content, tokens,
   connection strings before every commit.
6. Review `git diff` (and `git diff --staged`) before committing.
7. Run `npm test` (and the frontend build, if touching shared contracts)
   before committing.
8. Make focused commits — don't bundle unrelated changes.
9. Use descriptive commit messages.
10. Push only after tests/build pass and the diff has been reviewed.
11. Never modify the frontend repository from here, or vice versa.
12. Check the current branch before committing (`main` is the deploy branch
    here).
13. Keep backend and frontend commits in their own repositories — never mix
    them into one commit.

## Current Technical Debt

- **`app.js` has been split** into `routes/authRoutes.js`,
  `routes/debugRoutes.js`, `routes/strategyRoutes.js`,
  `routes/watchlistRoutes.js`, `routes/backtestRoutes.js`,
  `routes/dashboardRoutes.js` (plus the pre-existing
  `routes/stockAnalysisRoutes.js`) and `middleware/rateLimiters.js`. `app.js`
  is now ~254 lines: Express/Helmet/CORS/JSON setup, mounting each router,
  error handlers, and the `startServer`/graceful-shutdown bootstrap. All
  route modules follow the dependency-injection factory pattern
  (`createXRoutes({ ...deps })`) `stockAnalysisRoutes.js` already used —
  keep using that pattern for any new router.
- **`marketDataService.js` is still a large single file** (WS client + REST
  polling + indicator computation + caching + subscription management). Not
  split — higher risk/lower payoff than the `app.js` split since its
  functions are more interdependent (shared module-level state like
  `liveData`/`indicatorSnapshot`/`subscribedInstruments`).
- **In-memory caches are per-process.** If this is ever scaled to multiple
  backend instances, `upstoxRequestQueue`, `boundedCache`-based caches, and
  `liveData`/`indicatorSnapshot` all need a shared store (e.g. Redis) — not
  introduced yet, per explicit instruction to avoid that dependency for now.
- **A real secret was once committed to this repo's git history** (a MongoDB
  connection string, in the very first commit) and was later purged via a
  history rewrite (see the git log around the purge date below). If you ever
  see a secret in a diff or in history again, STOP and flag it — do not
  rewrite history without explicit confirmation from the project owner.
- **`batchedStockUpdates`/`onStockUpdate` dead Socket.IO wiring** on the
  frontend (see "Important API Rules" above) — harmless but confusing; only
  `marketTick` is real.
- **Malformed-ObjectId validation covers route params and the two known
  body-supplied ids** (`strategyId`/`watchlistId` in `/api/strategies/run`,
  `strategyId` in `/api/backtest/run`). If you add a new route that accepts
  an id from the body, validate it the same way.

## Change History / Context

### 2026-10-05 — Security & reliability hardening pass

Implemented in this session (continuing from a prior session's initial
hardening pass):
- Fixed malformed-ObjectId handling: added `middleware/validateObjectId.js`
  and applied it to every route with an ObjectId path param, plus inline
  validation for body-supplied ids in `/api/strategies/run` and
  `/api/backtest/run`. Malformed ids now return 400 instead of 500.
- Added bounded TTL+LRU caching (`utils/boundedCache.js`) for the PE-ratio
  cache, instrument-search cache, and invalid-instrument-key cache — all
  previously grew unbounded. Added size-capped pruning + unsubscribe-time
  cleanup for `liveData`/`indicatorSnapshot`.
- Verified (did not newly fix — already correct from the prior pass): DB-level
  ownership scoping on every watchlist/strategy/backtest route, CORS
  allowlisting, debug-endpoint gating, rate limiting, centralized error
  handling, Upstox 429 retry/backoff, graceful shutdown.
- Discovered and (with explicit owner approval) purged a real MongoDB
  connection string from this repo's git history via `git filter-repo`,
  force-pushed the cleaned history.
- Added `tests/boundedCache.test.js`; all existing tests still pass.

Prior pass (same hardening effort, earlier session) had already implemented:
IDOR fixes, CORS/Socket.IO origin restriction, debug-endpoint removal/gating,
Helmet, auth/backtest/write rate limiting, centralized error handling,
Upstox 429 retry/backoff/jitter/Retry-After, graceful shutdown, dead-code
removal (`Stock` model, `/api/seed-stocks`, unused `User.password`).

### 2026-10-05 (later) — Fixed missing option Greeks in watchlist data

Diagnosed and fixed a real bug (unrelated to the hardening pass above,
pre-existing since 2026-07-07): `buildQuickRow()` in
`services/marketDataService.js` — the row builder behind
`GET /api/market-data/:watchlistId`, the only data source for `StockTable`
and `GreekTable` on the frontend — never read or returned
`delta`/`gamma`/`theta`/`vega`/`iv`/`oi`/`oiChange`/`optionPremium`, even
though those values already existed on `liveData`/`indicatorSnapshot`.
Added the 8 missing fields with the same live-then-snapshot-then-null
precedence already used for the other fields in that function. Purely
additive, no other logic touched. Verified: `oi`/`oiChange` now surface
real numeric values (sourced from candle data, independent of the Upstox
WS feed); `delta`/`gamma`/`theta`/`vega`/`iv` correctly stay `null` while
the separate Upstox WebSocket-connection issue (see below) is unresolved,
since those five fields have no other data source in this codebase.

**Also corrected:** production backend URL is
`https://markfinancebackend1.onrender.com`, not
`https://markfinancebackend.onrender.com` (both were found to serve
identical code/data at diagnosis time, but only the `1` URL is the
intended one — the frontend's `netlify.toml` was pointing at the wrong
one and has been corrected).

**Still open:** the Upstox WebSocket feed fails to connect in production
(`marketStatus` stays `"Upstox Live (REST)"`; a local repro showed
`Unexpected server response: 403` on the feed authorize/connect). Not
fixed in this pass — needs Render log access or further Upstox-side
investigation to confirm the exact cause before touching
`connectFeed()`/`authorizeFeed()`.

### 2026-10-05 (later still) — Split app.js; fixed null-coerced-to-zero display bugs

- Split `app.js` into per-domain route modules (see Current Technical Debt
  above for the file list). Pure reorganization, verified with a full live
  regression of every route (CRUD, IDOR, malformed-ID, auth gating,
  strategy run, backtest run) against a local server before committing —
  no behavior change.
- (Frontend) Fixed a bug class where `Number(null) === 0` caused several
  UI fields to render a misleading "0"/"Below"/wrong-trend instead of "--"
  when quote data was genuinely missing (not this repo, but noting it here
  since it was found while verifying the Greeks fix) — see the frontend
  repo's `CLAUDE.md` change history for details.

### 2026-10-05 (later still) — Split the Upstox request queue into priority lanes

Diagnosed (read-only, no code changes) why adding a stock and populating
RSI/DMA on Stock Analysis felt slow (5-7s): `utils/upstoxRequestQueue.js` had
a single global serialized queue shared by every Upstox REST caller. A
watchlist refresh fires ~8-9 candle-fetch calls per instrument (5 timeframes)
through `candleService.js`/`instrumentIndicatorBundle.js` to compute
indicators — for a 5-stock watchlist that's 40+ queued calls. Those queued
ahead of (or interleaved with) `marketDataService.warmLiveQuotes()`'s LTP
lookup, which is what `GET /api/market-data/:id` actually awaits before
responding.

Fix: added `"critical"`/`"background"` priority lanes to the queue (see
"Market Data" above for the mechanics). `warmLiveQuotes()` now enqueues at
`"critical"`; candle/PE fetches stay `"background"`. Both lanes still share
one throttle clock, so this changes queue *ordering* only — it does not
relax the combined Upstox rate limit. Verified locally: a brand-new
watchlist with 5 never-before-subscribed instruments returned
`GET /api/market-data/:id` in ~0.17-0.5s (RSI/EMA correctly `null` at that
point, since the background bundle fetch is still in flight), with all five
instruments' indicators populated roughly 0.7-1s later via Socket.IO ticks —
all local-network timing, not directly comparable to the ~5-7s reported in
production (Render + real Upstox latency), but confirms the critical lookup
no longer waits behind the background backlog. Added
`tests/upstoxRequestQueue.test.js` coverage for lane ordering
(critical jumps a queued background backlog; default/no-`priority` behaves
as background). All existing tests still pass.

**Update this section whenever a future session makes a major
architectural or security change — don't let it go stale.**
