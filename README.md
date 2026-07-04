# tempel-ban

Autonomous volume-farming bot for the [Temple Canton](https://templedigitalgroup.com) exchange (Amulet/CC, USDA, CBTC on the Canton network). Runs a balance-driven ping-pong loop to farm trading volume, built on the official `@temple-digital-group/temple-canton-js` SDK.

> ⚠️ **Mainnet, real funds.** This bot places live orders with real money. Read the whole README, run on a throwaway balance first, and never commit your `.env`.

## What it does

A two-sided ping-pong loop that drains one side's spend asset, waits for everything to settle, deposits the other side's asset from the wallet, then flips:

```
resolve side (larger-USD trading asset)
  → place orders at best bid/ask (limit) or crossing (market)
  → drain spend asset
  → wait until all orders settle
  → deposit largest-USD wallet asset (proxy-gated)
  → flip side, repeat
```

Features:
- **Limit or market orders** per pair. Limit rests at best bid/ask (maker); market crosses the spread for an immediate taker fill with a slippage-capped price.
- **Real-time orderbook** via WebSocket (L2 book maintained locally — no REST polling lag), so quotes glue to the top of book.
- **5-state settlement tracking** — `placed → pending → settling → settled / cancelled` — derived from the trades feed, accurate across restarts.
- **Auto rate-adaptation** to the server's per-symbol order cap (`rate_limit_orders_per_minute`).
- **Proxy-gated deposits** — Cantonloop wallet auth blocks datacenter IPs, so deposits route through a residential proxy pool with rotation. Trading runs direct (no proxy needed).
- **Top-of-book re-quoting** — resting orders that drift out of the top-N levels or pass their TTL are cancelled and re-placed at the fresh best.
- **TUI dashboard** (blessed) + optional **Telegram** notifications (wallet/temple balances, order status, rewards).

## Setup

Requires Node 20+ (ESM only).

```bash
npm install
cp .env.example .env   # then fill it in
```

`.env`:

| Var | Required | Notes |
|-----|----------|-------|
| `TEMPLE_API_KEY` | ✅ | Temple REST key (trading). |
| `LOOP_PRIVATE_KEY` | ✅ | Loop wallet key (Ed25519, server-mode signing — deposits). |
| `LOOP_PARTY_ID` | ✅ | Canton party id. |
| `NETWORK` | ✅ | `mainnet` or `testnet`. |
| `proxy.txt` (file) | for deposits | Easiest proxy setup: one proxy URL per line (copy `proxy.txt.example`). Gitignored. |
| `PROXY_FILE` | optional | Override the default `proxy.txt` path. |
| `PROXY_URL` / `PROXY_LIST` | optional | Single proxy / comma-newline pool (merged with `proxy.txt`). |
| `PROXY_SCOPE` | optional | `wallet` (default — proxy only the wallet/deposit path) or `all`. |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | optional | Omit to disable notifications. |

## Run

```bash
npm start          # run the bot (TUI dashboard)
npm run dev        # watch mode
npm test           # unit tests
npm run typecheck  # type-check only
npm run diagnose   # one-shot account/connectivity check
npm run deposit    # manual deposit
npm run canary     # single canary order
```

## Configuration — `config.json`

```jsonc
{
  "pairs": [
    { "symbol": "CC/USDA",   "side": "auto", "enabled": false, "pingpong": true, "quantityPerOrder": 100 },
    { "symbol": "CBTC/USDA", "side": "buy",  "enabled": true,  "pingpong": true, "quantityPerOrder": 0.0001, "orderType": "limit" }
  ],
  "budgetPerOrder": 150,
  "orderTtlMinutes": 5,
  "marketSlippagePct": 0.005,
  ...
}
```

Per-pair:

| Key | Meaning |
|-----|---------|
| `symbol` | `BASE/QUOTE` trading pair. |
| `side` | Starting phase: `buy`, `sell`, or `auto` (largest-USD trading asset). |
| `enabled` | Toggle the pair on/off. |
| `pingpong` | Two-sided drain→deposit→flip loop (vs. single-sided refill). |
| `quantityPerOrder` | Order size in **base token** (e.g. `0.0001` CBTC). Overrides `budgetPerOrder`. |
| `orderType` | `limit` (rest at best, maker) or `market` (cross spread, taker). |
| `postOnly` | Maker-only guarantee (limit only). |

Global:

| Key | Meaning |
|-----|---------|
| `budgetPerOrder` | Fallback order size as a **quote notional**, used only when a pair has no `quantityPerOrder`. |
| `orderTtlMinutes` | A resting limit order older than this (and unfilled) is cancelled and re-placed at best. |
| `marketSlippagePct` | Slippage buffer for market orders (`0.005` = 0.5%). The API requires a price even for market orders and treats it as a worst-case fill cap; the buffer guarantees the order crosses. |
| `maxOpenOrders` | Max concurrent resting orders per pair (`"auto"` derives it from rate × TTL). |
| `walletReserve` | Per-asset amount to keep in the wallet (never deposit). |
| `minWalletCc` | Gas guard — stop all deposits when wallet CC falls below this (each deposit burns CC). |
| `ratePerMinute` / `maxRatePerMinute` | Order-rate floor/ceiling; self-adapts to the server cap. |
| `pollIntervalSec` | Reconcile/poll cadence. |
| `summaryIntervalMin` | Telegram summary cadence. |

## Architecture

```
src/
  index.ts            entry — initialize SDK, wire orchestrator + workers + UI
  config/             zod-validated config + env schema
  core/               pure logic — order sizing, rate limiter, status, requote/deposit policy
  services/           SDK wrapper, live orderbook (WS), proxy, wallet, telegram
  state/store.ts      single in-memory source of truth (event-emitting)
  workers/
    orchestrator.ts   reconcile loop, lazy wallet, deposits, rewards
    pair-worker.ts    per-pair state machine — resolve side → requote → place
  ui/dashboard.ts     blessed TUI
```

## Notes & gotchas

- The SDK is **error-as-value** — REST wrappers never throw; they resolve `{ error: true, ... }`. The wrapper in `services/sdk.ts` normalizes this.
- `createOrderRequest` returns a `request_id` (int tracking id), **not** an `order_id`. The `order_id` is resolved later from the active-orders / trades feed.
- Holdings fragment into many UTXOs; the deposit path merges them where needed.
- `deposit()` reserves 10 CC for transaction fees.

## License

Private project. No license granted.
