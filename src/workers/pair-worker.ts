import type { TempleSdk } from '../services/sdk.js';
import type { Store } from '../state/store.js';
import type { Config, PairConfig } from '../config/index.js';
import { budgetFor } from '../config/index.js';
import { sizeOrder, sizeByQuantity } from '../core/order-sizer.js';
import { RateLimiter } from '../core/ratelimiter.js';
import { shouldRequote } from '../core/requote-policy.js';
import { isLive, isResting } from '../core/status.js';
import { spendAsset, splitPair, usdValue, type Side, type TrackedOrder } from '../types.js';
import { TempleApiError } from '../services/sdk.js';

export interface DepositManager {
  /** Serialized refill — deposits the wallet's largest-USD relevant asset. */
  requestDeposit(symbol: string): Promise<void>;
}

interface SymbolMeta {
  minQty: number;
  /** Decimals for PRICE (max_decimals). 0 = integer prices. */
  priceDecimals: number;
  /** Decimals for QUANTITY, derived from minimum_quantity (e.g. 0.0001 → 4). */
  qtyDecimals: number;
  /** Server's per-symbol order cap: rate_limit_orders_per_minute. */
  ordersPerMinute: number;
  paused: boolean;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Round to `decimals` places, biased up or down to a valid price tick. */
function roundTo(n: number, decimals: number, dir: 'up' | 'down'): number {
  const f = 10 ** decimals;
  const r = dir === 'up' ? Math.ceil(n * f) : Math.floor(n * f);
  return r / f;
}

/** Count decimal places of a number (0.0001 → 4, 100 → 0). */
function decimalsOf(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  const s = n.toExponential();
  const m = /e-(\d+)$/.exec(s);
  if (m) return Number(m[1]);
  const dot = String(n).indexOf('.');
  return dot < 0 ? 0 : String(n).length - dot - 1;
}

/**
 * Per-pair state machine: resolve side → re-quote stale orders → place fresh
 * limits at best price while the trading balance funds them → when depleted,
 * ask the (shared) deposit manager to refill, then continue. Headless; all
 * observable state goes through the Store.
 */
export class PairWorker {
  private running = false;
  private meta?: SymbolMeta;
  private metaFetchedAt = 0;
  /** Dedicated order-placement limiter at the symbol's rate_limit_orders_per_minute. */
  private orderLimiter?: RateLimiter;
  private orderRate = 0;
  /** Ping-pong phase (alternates buy↔sell). Set from config in start(). */
  private phase: Side = 'buy';

  constructor(
    private readonly sdk: TempleSdk,
    private readonly store: Store,
    private readonly config: Config,
    private readonly pair: PairConfig,
    private readonly deposits: DepositManager,
  ) {}

  get symbol(): string {
    return this.pair.symbol;
  }

  async start(): Promise<void> {
    this.running = true;
    this.phase = this.pair.side === 'sell' ? 'sell' : 'buy';
    this.store.initPair(this.pair.symbol, this.pair.side);
    // Resume: if the orchestrator adopted existing orders for this pair on
    // startup, continue on their side rather than the configured default.
    const existing = this.store.ordersForPair(this.pair.symbol);
    if (existing.length > 0 && existing[0]) {
      this.phase = existing[0].side;
      this.store.patchPair(this.pair.symbol, { note: `resumed ${this.phase} (${existing.length} open)` });
    }
    while (this.running) {
      try {
        await this.tick();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.store.recordError(`pair:${this.pair.symbol}`, msg);
        await sleep(this.backoffMs());
      }
    }
  }

  stop(): void {
    this.running = false;
  }

  private backoffMs(): number {
    return Math.max(2000, this.config.pollIntervalSec * 1000);
  }

  /**
   * (Re)build the order-placement limiter from the symbol's orders/minute cap.
   * Fixed rate (no AIMD growth past the cap), evenly spaced (60s/rate) so we
   * never exceed the per-minute order limit — e.g. 6/min → one order every 10s.
   */
  private applyOrderRate(ordersPerMinute: number): void {
    // 0 / null = no per-symbol order cap → no dedicated order limiter (the shared
    // limiter still paces all requests). Otherwise pin a hard, evenly-spaced cap.
    if (!ordersPerMinute || ordersPerMinute <= 0) {
      this.orderLimiter = undefined;
      this.orderRate = 0;
      this.store.patchPair(this.pair.symbol, { note: 'order limit: none' });
      return;
    }
    if (this.orderLimiter && this.orderRate === ordersPerMinute) return;
    this.orderRate = ordersPerMinute;
    this.orderLimiter = new RateLimiter({
      ratePerMinute: ordersPerMinute,
      maxRatePerMinute: ordersPerMinute, // hard cap — never place faster than allowed
      minIntervalMs: Math.ceil(60_000 / ordersPerMinute),
    });
    this.store.patchPair(this.pair.symbol, { note: `order limit ${ordersPerMinute}/min` });
  }

  private async loadMeta(): Promise<SymbolMeta> {
    // Cached, but refreshed every few minutes so a server-side change to
    // rate_limit_orders_per_minute / minimum_quantity is picked up automatically.
    const fresh = this.meta && Date.now() - this.metaFetchedAt < 5 * 60_000;
    if (fresh) return this.meta!;
    try {
      const cfg = await this.sdk.getSymbolConfig(this.pair.symbol);
      const minQty = cfg?.minimum_quantity ?? 0;
      this.meta = {
        minQty,
        // max_decimals is PRICE precision (0 = integer prices for CBTC/USDA).
        priceDecimals: cfg?.max_decimals ?? 0,
        // Quantity precision follows the minimum increment (0.0001 → 4 places).
        qtyDecimals: decimalsOf(minQty) || 4,
        // null = no per-minute order cap for this symbol (e.g. CC/USDA). 0 = uncapped.
        ordersPerMinute: cfg?.rate_limit_orders_per_minute ?? 0,
        paused: Boolean(cfg?.paused),
      };
      this.metaFetchedAt = Date.now();
      this.applyOrderRate(this.meta.ordersPerMinute);
    } catch {
      // Config fetch failed → assume the conservative 6/min cap.
      this.meta ??= { minQty: 0.0001, priceDecimals: 0, qtyDecimals: 4, ordersPerMinute: 6, paused: false };
      this.applyOrderRate(this.meta.ordersPerMinute);
    }
    return this.meta;
  }


  /** Cancel + drop any resting order past its TTL so it can be re-placed. */
  private async requoteStale(): Promise<void> {
    const ttlMs = this.config.orderTtlMinutes * 60_000;
    const minAgeMs = this.config.requoteMinAgeSec * 1000;
    const live = this.store.liveBooks[this.pair.symbol];
    const bookFresh = Boolean(live && Date.now() - live.ts < 5_000);
    const now = Date.now();
    for (const o of this.store.ordersForPair(this.pair.symbol)) {
      // Only resting orders are re-quotable.
      if (!isResting(o.status) || !o.orderId) continue;
      const ageMs = now - o.placedAt;

      // Top-of-book drift: a resting order older than minAge that has fallen out
      // of the top-N book levels gets cancelled and re-placed at the fresh best —
      // keeps quotes glued to the top instead of drifting off as the market moves.
      let drifted = false;
      if (bookFresh && ageMs >= minAgeMs) {
        const n = this.config.topOfBookLevels;
        if (o.side === 'buy') {
          const topBids = live!.bids.slice(0, n);
          if (topBids.length > 0 && o.price < Math.min(...topBids)) drifted = true;
        } else {
          const topAsks = live!.asks.slice(0, n);
          if (topAsks.length > 0 && o.price > Math.max(...topAsks)) drifted = true;
        }
      }

      const ttlExpired = shouldRequote({ status: o.status, ageMs, ttlMs });
      if (!drifted && !ttlExpired) continue;
      try {
        this.store.recordError('requote', `${o.side} @${o.price} ${drifted ? 'off-top' : 'TTL'} → re-quote at best`);
        await this.sdk.cancelOrder(o.orderId);
        this.store.markCancelled(o.requestId);
      } catch (e) {
        // settling/raced cancel — leave it; reconciler will catch up.
        this.store.recordError(`requote:${this.pair.symbol}`, e instanceof Error ? e.message : String(e));
      }
    }
  }

  private async tick(): Promise<void> {
    const meta = await this.loadMeta();
    // Global health guard: stop placing while the exchange is paused/killswitched.
    if (this.store.tradingHalted) {
      this.store.patchPair(this.pair.symbol, { paused: true, note: 'exchange paused (killswitch/tradingPaused)' });
      await sleep(this.backoffMs());
      return;
    }
    if (meta.paused) {
      this.store.patchPair(this.pair.symbol, { paused: true, note: 'symbol paused' });
      await sleep(this.backoffMs());
      return;
    }
    const pairOrders = this.store.ordersForPair(this.pair.symbol);
    this.store.patchPair(this.pair.symbol, {
      paused: false,
      orderRate: this.orderRate,
      maxOpen: this.effectiveMaxOpen(meta),
      openOrders: pairOrders.filter((o) => o.status === 'placed').length,
      settlingOrders: pairOrders.filter((o) => o.status === 'pending' || o.status === 'settling').length,
    });

    await this.requoteStale();

    if (this.pair.pingpong) {
      await this.tickPingPong(meta);
    } else {
      await this.tickSingleSided(meta);
    }
    await sleep(this.backoffMs());
  }

  /** Single-sided (spec default): fixed side, refill from wallet when settled. */
  private async tickSingleSided(meta: SymbolMeta): Promise<void> {
    const side = this.pair.side === 'sell' ? 'sell' : 'buy';
    this.store.patchPair(this.pair.symbol, { resolvedSide: side });
    if ((await this.placeWhileFunded(side, meta)) > 0) return;
    const live = this.store.ordersForPair(this.pair.symbol).filter((o) => isLive(o.status)).length;
    if (live === 0) await this.deposits.requestDeposit(this.pair.symbol);
  }

  /**
   * Balance-driven two-sided trading (no fixed phases):
   *  - SIDE is the trading asset with the larger USD value: USD(quote) ≥ USD(base)
   *    → buy (spend quote); else → sell (spend base).
   *  - When the chosen side can't be funded AND everything has settled
   *    (pending+settling+resting = 0), deposit the wallet's largest-USD relevant
   *    asset (the deposit manager decides which). Side then re-resolves next tick.
   */
  private async tickPingPong(meta: SymbolMeta): Promise<void> {
    const { base, quote } = splitPair(this.pair.symbol);
    const px = this.store.oraclePrices;
    const bal = await this.sdk.getTradingBalance();
    const usdQuote = usdValue(quote, bal[quote] ?? 0, px);
    const usdBase = usdValue(base, bal[base] ?? 0, px);
    const side: Side = usdQuote >= usdBase ? 'buy' : 'sell'; // spend the larger-USD trading asset
    this.phase = side;
    this.store.patchPair(this.pair.symbol, { resolvedSide: side });

    if ((await this.placeWhileFunded(side, meta)) > 0) return; // progress

    // Can't place. Wait while anything is still live (resting/pending/settling).
    const live = this.store.ordersForPair(this.pair.symbol).filter((o) => isLive(o.status)).length;
    if (live > 0) {
      this.store.patchPair(this.pair.symbol, { note: `${side}: waiting ${live} unsettled` });
      return;
    }
    // All settled + can't fund this side → refill from the wallet's largest-USD asset.
    this.store.patchPair(this.pair.symbol, { note: `${side} drained → deposit largest-USD wallet asset` });
    await this.deposits.requestDeposit(this.pair.symbol);
  }

  /** Live WS top-of-book if fresh (<3s) and not crossed, else a fresh REST read. */
  private async topOfBook(): Promise<{ bestBid?: number; bestAsk?: number }> {
    const live = this.store.liveBooks[this.pair.symbol];
    const fresh = live && Date.now() - live.ts < 3_000 && live.bestBid && live.bestAsk;
    // Guard a crossed book (bestAsk <= bestBid = transient bad state) — placing
    // off it would cross the spread. Fall back to a REST read.
    if (fresh && live!.bestAsk! > live!.bestBid!) {
      return { bestBid: live!.bestBid, bestAsk: live!.bestAsk };
    }
    return this.sdk.getBookTop(this.pair.symbol);
  }

  /** Count resting (pending) orders for this pair. */
  private openOrderCount(): number {
    return this.store.ordersForPair(this.pair.symbol).filter((o) => o.status === 'placed').length;
  }

  /**
   * Effective concurrent-order cap. A configured number is used as-is (clamped
   * to the account limit). `"auto"` = how many orders accumulate within one TTL
   * window at the symbol's order rate, clamped to max_limit_orders and a safety
   * ceiling. Adapts as the server's rate / account limit are learned.
   */
  private effectiveMaxOpen(meta: SymbolMeta): number {
    const accountMax = this.store.maxLimitOrders ?? 100;
    const cfg = this.config.maxOpenOrders;
    if (typeof cfg === 'number') return Math.max(1, Math.min(cfg, accountMax));
    const rate = meta.ordersPerMinute > 0 ? meta.ordersPerMinute : 30; // uncapped symbol → brisk default
    const byWindow = Math.ceil(rate * this.config.orderTtlMinutes);
    return Math.max(1, Math.min(byWindow, accountMax, 200));
  }

  /**
   * Place orders on `side` while funded AND under the open-order cap. Fetches
   * the book price and balance ONCE, then places multiple orders, tracking the
   * remaining spend locally — keeps API calls to ~N+2 instead of 3N (avoids the
   * 429 storm from re-reading book+balance on every order).
   */
  private async placeWhileFunded(side: Side, meta: SymbolMeta): Promise<number> {
    const asset = spendAsset(this.pair.symbol, side);
    const maxOpen = this.effectiveMaxOpen(meta);

    const slots = maxOpen - this.openOrderCount();
    if (slots <= 0) {
      this.store.patchPair(this.pair.symbol, { note: `${maxOpen} open orders (cap)` });
      return 0;
    }

    // Balance changes only on fills (slow) → fetch once and decrement locally.
    const bal = await this.sdk.getTradingBalance();
    let funds = bal[asset] ?? 0;

    let placed = 0;
    while (placed < slots) {
      // Wait for the order-rate slot FIRST, THEN read the price — otherwise the
      // ~10s the limiter waits would make the price stale by ~10 ticks in a fast
      // market. This way the price is fetched right before the order is sent.
      await this.orderLimiter?.acquire();

      // Real-time top-of-book: live WS (instant), REST fallback if stale.
      const { bestBid, bestAsk } = await this.topOfBook();
      // Limit rests at our own side (buy→bid, sell→ask). Market crosses the
      // spread for an immediate fill (buy→ask, sell→bid) — the API still
      // requires a price > 0, so we send the crossing top-of-book level.
      const isMarket = this.pair.orderType === 'market';
      // `touch` = the real best price the order fills/rests at — this is what we
      // TRACK (for trade matching + volume). For a market order the WIRE price
      // sent to the API is padded past the touch (worst-case fill cap) so a
      // 1-tick move can't leave it un-crossed (instant no-fill cancel).
      const touch = isMarket
        ? (side === 'buy' ? bestAsk : bestBid)
        : (side === 'buy' ? bestBid : bestAsk);
      if (!touch || touch <= 0) {
        this.store.patchPair(this.pair.symbol, { note: 'no book price' });
        break;
      }
      let wirePrice = touch;
      if (isMarket) {
        const s = this.config.marketSlippagePct;
        wirePrice = side === 'buy'
          ? roundTo(touch * (1 + s), meta.priceDecimals, 'up')
          : roundTo(touch * (1 - s), meta.priceDecimals, 'down');
      }
      const sized = this.sizeOrder(touch, meta);
      if ('skip' in sized) {
        this.store.patchPair(this.pair.symbol, { note: sized.reason });
        break;
      }
      const qty = sized.quantity;
      // Cost in the spend asset: buy spends quote (qty×wirePrice, the worst case),
      // sell spends base (qty).
      const cost = side === 'buy' ? qty * wirePrice : qty;
      if (funds < cost) break;

      const ok = await this.placeOrder(side, touch, qty, isMarket, wirePrice);
      if (!ok) break; // 429 / rejected — stop; limiter already paused
      placed += 1;
      funds -= cost;
      this.store.patchPair(this.pair.symbol, { bestBid, bestAsk, lastQty: qty });
    }
    return placed;
  }

  /**
   * Resolve the order quantity. Preferred mode is a fixed BASE-token size
   * (`quantityPerOrder`, e.g. 100 CC, 0.0001 CBTC). If a pair has no
   * quantityPerOrder, fall back to the quote-notional budget.
   */
  private sizeOrder(price: number, meta: SymbolMeta) {
    // Quantity is floored to qtyDecimals (from minimum_quantity) — NOT max_decimals
    // (which is price precision; 0 would wrongly floor 0.0001 → 0).
    if (this.pair.quantityPerOrder !== undefined) {
      return sizeByQuantity({
        quantity: this.pair.quantityPerOrder,
        minimumQuantity: meta.minQty,
        maxDecimals: meta.qtyDecimals,
        onBelowMin: this.config.onBelowMin,
      });
    }
    return sizeOrder({
      budgetPerOrder: budgetFor(this.config, this.pair),
      price,
      minimumQuantity: meta.minQty,
      maxDecimals: meta.qtyDecimals,
      onBelowMin: this.config.onBelowMin,
    });
  }

  /**
   * Place one order (limit or market). Returns true if placed, false on 429.
   * `price` is the TRACKED touch (used for matching + volume); `wirePrice` is
   * what's actually sent — equal to `price` for limits, padded for markets.
   */
  private async placeOrder(side: Side, price: number, quantity: number, isMarket = false, wirePrice = price): Promise<boolean> {
    const ttlMs = this.config.orderTtlMinutes * 60_000;
    // A market order fills immediately, so a TTL is moot — only set expiry for limits.
    const expiresAt = isMarket ? undefined : new Date(Date.now() + ttlMs + 30_000).toISOString(); // TTL + buffer
    // NOTE: the order-rate slot is acquired by the caller (placeWhileFunded)
    // BEFORE reading the price, so the price is fresh at send time.
    try {
      const requestId = await this.sdk.placeLimit({
        symbol: this.pair.symbol,
        side,
        quantity,
        price: wirePrice,
        orderType: isMarket ? 'market' : 'limit',
        postOnly: this.pair.postOnly,
        expiresAt,
      });
      const order: TrackedOrder = {
        requestId,
        symbol: this.pair.symbol,
        side,
        price,
        quantity,
        status: 'placed',
        placedAt: Date.now(),
        updatedAt: Date.now(),
      };
      this.store.addOrder(order);
      this.orderLimiter?.onSuccess(); // adapt the order rate upward on sustained success
      return true;
    } catch (e) {
      // 429: feed the order limiter so it self-throttles below the (mis)guessed
      // rate, then stop the place loop (don't keep hammering).
      if (e instanceof TempleApiError && e.is429) {
        this.orderLimiter?.on429();
        return false;
      }
      throw e;
    }
  }
}
