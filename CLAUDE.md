# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Greenfield bot project (`temple-opusxfable`, in `bot-erdrop/`). No application source exists yet — only `package.json` and the one dependency it's built around: `@temple-digital-group/temple-canton-js`, the JS SDK for the Temple Canton blockchain exchange (Amulet/CC, USDCx, CBTC tokens on the Canton network).

When adding code, the whole task is driving this SDK — read its README at `node_modules/@temple-digital-group/temple-canton-js/README.md` (full API reference) before writing against it.

## Environment

- **ESM only.** The SDK is `"type": "module"`. The root `package.json` has no `"type"` field yet — add `"type": "module"` or use `.mjs` files, otherwise imports fail.
- No build, lint, or test setup exists. No git repo initialized. Run scripts with `node <file>.mjs`.
- Config/secrets come from `process.env` (loaded via the SDK's `dotenv` dep) or are passed to `initialize()`. Use a `.env` file; never commit it.

## SDK usage essentials

`initialize(config)` MUST be called before any other SDK function. Required keys: `API_KEY` (Temple REST key), `NETWORK` (`mainnet`/`testnet`/`localhost`), `WALLET_ADAPTER` (Loop SDK instance — auto-detects server vs client signing).

Symbol normalization: use `CC` for Canton Coin everywhere; `Amulet` is deprecated (SDK converts internally where the ledger needs it). Trading pairs: `CC/USDCx`, `CBTC/USDCx`.

### v2 trading lifecycle (the spine of any bot here)

```
isUserOnboarded(party) → onboardUser(party) if not   # delegation contract
deposit(amount, symbol)                                # reserves 10 CC for fees
getTradingBalance()
createOrderRequest({ symbol, side, quantity, price, order_type })
cancelOrder(id) / cancelAllOrders({ symbol })
withdrawFunds({ asset_id, amount })
withdrawDelegation()                                   # user must re-onboard after
```

Gotchas baked into the SDK:
- `deposit()` reserves 10 CC for transaction fees; utility deposits (USDCx/CBTC) need both enough token *and* 10 CC.
- `onboardUser()` polls `isUserOnboarded` every 5s for up to 60s; returns a `warning` field if not confirmed in time.
- Holdings fragment into many UTXOs — use `getUtxoCount`, `mergeAmuletHoldingsForParty`, `mergeUtilityHoldingsForParty` to consolidate (merging CC requires disclosures from `getAmuletDisclosures`).

### Real-time data

Two WebSocket data classes, different mechanics:
- **Market data** (`subscribeOrderbook/Trades/Ticker/Candles/Oracle/OracleVolume`) — SDK sends an explicit subscribe message.
- **User data** (`subscribeUserOrders/UserTrades/UserBalances`) — auto-pushed after auth, no subscribe; requires `API_KEY` (Node) or cookie auth (browser).

Use `TempleWebSocket` directly for full control (`onConnect`/`onAuth`/`onError`, `autoReconnect` on by default). `disconnectWebSocket()` tears down the shared instance.

Candle granularities (seconds): `60` `300` `900` `3600` `14400` `86400`.

## SDK API surface map

Top-level export structure (see `node_modules/@temple-digital-group/temple-canton-js/index.js`):
- **Canton ledger client** + **config** — `src/canton/`, `src/config/`
- **Auth0** — `src/auth0/` (`getJWTToken`)
- **Temple REST API** — `dist/api/` (market data, trading, withdrawals, disclosures)
- **WebSocket** — `dist/websocket/`
