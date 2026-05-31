# Yahoo Finance Request Audit

All Yahoo calls route through `yahooClient.js`. User-facing market data reads `marketCache` via `marketEngine.js`.

| Endpoint | Yahoo Requests | Indicators Calculated | Cache | Avg Time (target) |
|----------|----------------|----------------------|-------|-------------------|
| `GET /api/market-data/:watchlistId` | 0 on cache hit; background warm only | Read from cache (RSI, EMA, volume) | `marketCache` | <200ms cached |
| `POST /api/strategies/run` | 0 (cache only) | None (reads cache) | `marketCache` | <500ms |
| `POST /api/backtest/run` | 1–6 charts per run | RSI, EMA (backtest path) | `yahooClient` chart cache | unchanged |
| `GET /api/search-stock` | 1 search per unique query | none | 300s search cache | low |
| `POST /api/watchlists/:id/stocks` | 1 quote + 1 quoteSummary | none | `yahooClient` | low |
| `POST /api/watchlists/:id/refresh-fundamentals` | 2 per stock | none | `yahooClient` | batch |
| `GET /api/debug/:symbol` | via engine refresh | full set | `marketCache` | dev only |
| `GET /test` | 1 quote | none | `yahooClient` | legacy |
| Market Engine (background) | deduplicated per symbol | full on indicator refresh; quote-only on price refresh | `marketCache` + Socket.IO | 15s open / 5m closed |
