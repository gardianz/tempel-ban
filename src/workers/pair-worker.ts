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

/**
 * Order submit pacing (user's model): fire orders in a BATCH `orderSpacingSec`
 * apart (default 2s); when the exchange rate-limits (429/249) back off for
 * `rateLimitCooldownSec` (default 30s), then resume the batch. Both configurable.
 */

/**
 * Documented hard cap: the exchange rejects order creation past 50 concurrent
 * ACTIVE orders with 409 `order_limit_exceeded`. Clamp our open-order target to
 * this so we never trip it (a lower account limit, if learned, wins).
 */
const MAX_ACTIVE_ORDERS = 50;

/** Why a place loop stopped — lets the tick distinguish rate-limit from no-funds. */
type PlaceReason = 'progress' | 'rate-limited' | 'no-funds' | 'cap' | 'no-price' | 'below-min';
interface PlaceResult {
  /** How many orders were actually placed this call. */
  placed: number;
  reason: PlaceReason;
}

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
  /** Last side we logged (dedup the side-resolution note). */
  private lastLoggedSide?: Side;
  /** Last funding state we logged: 'fund' (placing) | 'wait' | 'drain' | 'cooldown'. */
  private lastFundState?: string;
  /** Epoch ms of recent successful placements — learns the per-minute order cap. */
  private placeTimes: number[] = [];

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

  /** Batch spacing (ms) between order submits. Seeded from config at startup. */
  private get spacingMs(): number {
    return this.store.orderSpacingMs;
  }

  /**
   * Cooldown (ms) after a rate-limit before submitting again. Read LIVE from the
   * store so the user can change it at runtime (CLI `cooldown <sec>` / Telegram
   * `/cooldown <sec>`) — it applies to the very next 429 without a restart.
   */
  private get cooldownMs(): number {
    return this.store.rateLimitCooldownMs;
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
   * (Re)build the order-placement limiter. Pacing is a FLAT `orderSpacingSec`
   * (default 2s) between submits (batch model); the server's per-symbol
   * orders/minute cap is tracked for DISPLAY only, not turned into an even
   * spacing. When the exchange rate-limits, placeOrder pauses this limiter for
   * `rateLimitCooldownSec` (batch-then-cooldown-then-batch).
   */
  private applyOrderRate(ordersPerMinute: number): void {
    const spacingSec = (this.spacingMs / 1000).toFixed(0);
    const cooldownSec = (this.cooldownMs / 1000).toFixed(0);
    // Announce a server-side cap change (re-checked ~every 5 min via loadMeta) so
    // it's visible — but pacing stays fixed (batch + cooldown on limit).
    if (this.orderRate > 0 && this.orderRate !== ordersPerMinute) {
      this.store.note(
        'ratelimit',
        `${this.pair.symbol}: limit order/menit server berubah ${this.orderRate} → ${ordersPerMinute || 'tak dibatasi'} (info; pacing tetap batch ${spacingSec}s + cooldown ${cooldownSec}s saat kena limit)`,
      );
    }
    this.orderRate = ordersPerMinute || 0;
    // Build the limiter ONCE. The token bucket is set well above any real cap so
    // the effective gate is purely the batch min-interval (+ the cooldown pause).
    if (!this.orderLimiter) {
      this.orderLimiter = new RateLimiter({
        ratePerMinute: 600,
        maxRatePerMinute: 600,
        minIntervalMs: this.spacingMs,
        initialTokens: 600,
      });
      this.store.patchPair(this.pair.symbol, { note: `pacing: batch ${spacingSec}s + cooldown ${cooldownSec}s saat kena limit` });
    }
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


  /**
   * Cancel + drop any resting order past its TTL so it can be re-placed at best.
   * Only TTL drives re-quoting — orders also carry a server-side `expires_at`
   * (TTL + 30s) as a backstop. (No off-top/drift re-quote: it churned cancels in
   * a fast market and raced the server, producing a storm of 404s on already-gone
   * orders.)
   */
  private async requoteStale(): Promise<void> {
    const ttlMs = this.config.orderTtlMinutes * 60_000;
    const now = Date.now();
    for (const o of this.store.ordersForPair(this.pair.symbol)) {
      // Only resting orders are re-quotable.
      if (!isResting(o.status) || !o.orderId) continue;
      const ageMs = now - o.placedAt;
      if (!shouldRequote({ status: o.status, ageMs, ttlMs })) continue;
      try {
        this.store.note('requote', `${o.side} @${o.price} TTL lewat → re-quote at best`);
        await this.sdk.cancelOrder(o.orderId);
        this.store.markCancelled(o.requestId);
      } catch (e) {
        // 404/raced: the order already filled or expired server-side — leave it;
        // the reconciler reads its real settlement from the trades feed.
        this.store.note(`requote:${this.pair.symbol}`, `cancel dilewati (order sudah hilang/terisi): ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  private async tick(): Promise<void> {
    const meta = await this.loadMeta();
    // User pause (Telegram /stop): stop placing new orders; let resting ones settle.
    if (this.store.userPaused) {
      this.store.patchPair(this.pair.symbol, { paused: true, note: 'dijeda user (Telegram /stop)' });
      await sleep(this.backoffMs());
      return;
    }
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
    const r = await this.placeWhileFunded(side, meta);
    // Throttled or made progress → nothing to do; the batch resumes next tick.
    if (r.reason === 'rate-limited' || r.placed > 0) return;
    // Only a real out-of-funds with nothing live triggers a refill deposit.
    if (r.reason === 'no-funds') {
      const live = this.store.ordersForPair(this.pair.symbol).filter((o) => isLive(o.status)).length;
      if (live === 0) await this.deposits.requestDeposit(this.pair.symbol);
    }
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

    // Readable side-resolution log (only when the chosen side changes).
    if (this.lastLoggedSide !== side) {
      this.lastLoggedSide = side;
      const spend = side === 'buy' ? quote : base;
      const hi = side === 'buy' ? quote : base;
      const lo = side === 'buy' ? base : quote;
      this.store.note(
        `pair:${this.pair.symbol}`,
        `saldo ${hi} $${(side === 'buy' ? usdQuote : usdBase).toFixed(2)} > ${lo} $${(side === 'buy' ? usdBase : usdQuote).toFixed(2)} → side ${side} (belanja ${spend})`,
      );
    }

    const r = await this.placeWhileFunded(side, meta);

    // Rate-limited: cooldown is armed; the spend asset is NOT empty. Don't touch
    // the fund/deposit path — just wait out the cooldown and batch again next tick.
    if (r.reason === 'rate-limited') {
      if (this.lastFundState !== 'cooldown') {
        this.lastFundState = 'cooldown';
        this.store.note(`pair:${this.pair.symbol}`, `kena limit → cooldown, lalu pasang order batch lagi (saldo ${spendAsset(this.pair.symbol, side)} aman, bukan habis)`);
      }
      return;
    }

    if (r.placed > 0) {
      if (this.lastFundState !== 'fund') {
        this.lastFundState = 'fund';
        this.store.note(`pair:${this.pair.symbol}`, `saldo ${spendAsset(this.pair.symbol, side)} cukup → pasang order ${side}`);
      }
      return; // progress
    }

    // Placed nothing and NOT throttled. Only 'no-funds' means the spend asset is
    // actually drained; cap/no-price/below-min are transient — idle this tick.
    if (r.reason !== 'no-funds') {
      this.store.patchPair(this.pair.symbol, { note: `tak pasang order (${r.reason}), tunggu` });
      return;
    }

    // Out of funds. Wait while anything is still live (resting/pending/settling).
    const live = this.store.ordersForPair(this.pair.symbol).filter((o) => isLive(o.status)).length;
    if (live > 0) {
      this.store.patchPair(this.pair.symbol, { note: `${side}: waiting ${live} unsettled` });
      if (this.lastFundState !== 'wait') {
        this.lastFundState = 'wait';
        this.store.note(`pair:${this.pair.symbol}`, `saldo ${spendAsset(this.pair.symbol, side)} habis, tunggu ${live} order settle dulu`);
      }
      return;
    }
    // All settled + drained → refill from the wallet's largest-USD asset.
    this.store.patchPair(this.pair.symbol, { note: `${side} drained → deposit largest-USD wallet asset` });
    if (this.lastFundState !== 'drain') {
      this.lastFundState = 'drain';
      this.store.note(`pair:${this.pair.symbol}`, `${side} terkuras & semua settle → minta deposit dari wallet`);
    }
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
    // Never exceed the documented 50 active-order ceiling (409 order_limit_exceeded).
    const accountMax = Math.min(this.store.maxLimitOrders ?? MAX_ACTIVE_ORDERS, MAX_ACTIVE_ORDERS);
    const cfg = this.config.maxOpenOrders;
    if (typeof cfg === 'number') return Math.max(1, Math.min(cfg, accountMax));
    const rate = meta.ordersPerMinute > 0 ? meta.ordersPerMinute : 30; // uncapped symbol → brisk default
    const byWindow = Math.ceil(rate * this.config.orderTtlMinutes);
    return Math.max(1, Math.min(byWindow, accountMax));
  }

  /**
   * Place orders on `side` while funded AND under the open-order cap. Fetches
   * the book price and balance ONCE, then places multiple orders, tracking the
   * remaining spend locally — keeps API calls to ~N+2 instead of 3N (avoids the
   * 429 storm from re-reading book+balance on every order).
   */
  private async placeWhileFunded(side: Side, meta: SymbolMeta): Promise<PlaceResult> {
    const asset = spendAsset(this.pair.symbol, side);
    const maxOpen = this.effectiveMaxOpen(meta);

    const slots = maxOpen - this.openOrderCount();
    if (slots <= 0) {
      this.store.patchPair(this.pair.symbol, { note: `${maxOpen} open orders (cap)` });
      return { placed: 0, reason: 'cap' };
    }

    // Balance changes only on fills (slow) → fetch once and decrement locally.
    const bal = await this.sdk.getTradingBalance();
    let funds = bal[asset] ?? 0;

    let placed = 0;
    while (placed < slots) {
      // Wait for the batch-spacing slot FIRST, THEN read the price — otherwise the
      // wait would make the price stale by several ticks in a fast market. This
      // way the price is fetched right before the order is sent. If a cooldown is
      // active (post-429), this acquire also blocks until the cooldown ends.
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
        return { placed, reason: 'no-price' };
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
        return { placed, reason: 'below-min' };
      }
      const qty = sized.quantity;
      // Cost in the spend asset: buy spends quote (qty×wirePrice, the worst case),
      // sell spends base (qty).
      const cost = side === 'buy' ? qty * wirePrice : qty;
      if (funds < cost) return { placed, reason: 'no-funds' };

      const res = await this.placeOrder(side, touch, qty, isMarket, wirePrice);
      // Rate-limited: cooldown is already armed on the limiter — stop the batch
      // WITHOUT mislabeling it as out-of-funds (funds are fine, we're throttled).
      if (res === 'rate-limited') return { placed, reason: 'rate-limited' };
      // At the 50 active-order cap — stop the batch, treat like the cap slot path.
      if (res === 'at-cap') return { placed, reason: 'cap' };
      placed += 1;
      funds -= cost;
      this.placeTimes.push(Date.now()); // record for per-minute cap learning
      this.store.patchPair(this.pair.symbol, { bestBid, bestAsk, lastQty: qty });
    }
    return { placed, reason: 'progress' };
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
  private async placeOrder(side: Side, price: number, quantity: number, isMarket = false, wirePrice = price): Promise<'ok' | 'rate-limited' | 'at-cap'> {
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
      return 'ok';
    } catch (e) {
      // Rate-limited (429 or 249): arm an adaptive cooldown (see armCooldown),
      // mark the symbol (dashboard badge), then stop the batch (don't keep
      // hammering). Reads keep flowing so settlement still updates; the batch
      // resumes after the cooldown. NOT a funding problem — reported as such.
      if (e instanceof TempleApiError && e.isRateLimited) {
        this.armCooldown(e);
        return 'rate-limited';
      }
      // 50 active-order cap (409). Not fatal, not a rate-limit — just stop the
      // batch and let orders settle; no cooldown needed.
      if (e instanceof TempleApiError && (e.status === 409 || String(e.code ?? e.message).toLowerCase().includes('order_limit'))) {
        this.store.note(`pair:${this.pair.symbol}`, `cap ${MAX_ACTIVE_ORDERS} order aktif tercapai → tunggu order settle`);
        return 'at-cap';
      }
      throw e;
    }
  }

  /**
   * Arm the post-429 cooldown. The account's per-minute order cap isn't exposed
   * (symbol config is null, profile 404), so LEARN it from the 429: count our
   * successful placements in the trailing 60s window and wait until the OLDEST
   * one ages out — that's when the rolling per-minute cap frees a slot. Take the
   * max of that, any server Retry-After, and the user's configured cooldown
   * (which acts as a floor). This stops the wasteful "cooldown → 429 again"
   * loop that a fixed 30s cooldown caused against a ~2/min account limit.
   */
  private armCooldown(e: TempleApiError): void {
    const now = Date.now();
    const WINDOW_MS = 60_000;
    this.placeTimes = this.placeTimes.filter((t) => now - t < WINDOW_MS);
    const placedInWindow = this.placeTimes.length;
    const oldest = this.placeTimes[0];
    // Time until the oldest in-window placement ages past 60s (+0.5s buffer).
    const windowFreeMs = oldest !== undefined ? Math.max(0, WINDOW_MS - (now - oldest) + 500) : 0;
    // Server Retry-After, if the SDK surfaced one on the error-as-value.
    const cause = e.cause as { retry_after?: number } | undefined;
    const serverMs = typeof cause?.retry_after === 'number' ? cause.retry_after * 1000 : 0;
    const pauseMs = Math.max(this.cooldownMs, windowFreeMs, serverMs);
    this.orderLimiter?.pauseFor(pauseMs);
    this.store.setCooldown(this.pair.symbol, pauseMs);
    const why = serverMs > 0 ? 'Retry-After server' : windowFreeMs > this.cooldownMs ? `window ~${placedInWindow}/min` : 'cooldown user';
    this.store.note(
      `ratelimit:${this.pair.symbol}`,
      `kena limit order (429), ${placedInWindow} order/60s terakhir → cooldown ${(pauseMs / 1000).toFixed(0)}s (${why}) sebelum submit lagi`,
    );
  }
}
