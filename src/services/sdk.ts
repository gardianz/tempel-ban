import * as temple from '@temple-digital-group/temple-canton-js';
import { RateLimiter } from '../core/ratelimiter.js';

/** Typed error carrying HTTP status/code unwrapped from the SDK's ApiError. */
export class TempleApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string | number,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'TempleApiError';
  }

  get is429(): boolean {
    return this.status === 429;
  }

  /**
   * True for ANY rate-limit signal, not just HTTP 429. Temple has also been seen
   * to surface the throttle as code/status 249, so match both numbers on the
   * status AND the body code, plus a message fallback ("rate limit"/"too many").
   * The order path uses this to trigger a fixed cooldown before submitting again.
   */
  get isRateLimited(): boolean {
    if (this.status === 429 || this.status === 249) return true;
    if (this.code === 429 || this.code === 249 || this.code === '429' || this.code === '249') return true;
    const m = (this.message ?? '').toLowerCase();
    return m.includes('rate limit') || m.includes('too many') || m.includes('429') || m.includes('249');
  }
}

function toTempleError(e: unknown): TempleApiError {
  const err = e as { status?: number; code?: string | number; message?: string };
  return new TempleApiError(err?.message ?? String(e), err?.status, err?.code, e);
}

/**
 * The SDK signals failure by RESOLVING with an error-shaped object (it never
 * throws). Two shapes exist:
 *   - REST/trading:  { error: true, status, code, message }
 *   - Canton ledger: { error: "<message string>" }   (deposit/withdraw/onboard/merge)
 * Both use a TRUTHY `error` key. Matching only `error === true` (the old check)
 * let the string-error shape slip through as a "success" — a failed deposit was
 * recorded as sukses and the balance never landed. Detect either.
 */
interface SdkError {
  error: true | string;
  status?: number | null;
  code?: string | number | null;
  message?: string;
  retry_after?: number;
}
function isSdkError(v: unknown): v is SdkError {
  if (!v || typeof v !== 'object') return false;
  const e = (v as { error?: unknown }).error;
  return e === true || (typeof e === 'string' && e.length > 0);
}

/** Pull a Retry-After (ms) hint off an error-as-value if present. */
function retryAfterMs(e: SdkError): number | undefined {
  if (typeof e.retry_after === 'number') return e.retry_after * 1000;
  return undefined;
}

export interface BookTop {
  bestBid?: number;
  bestAsk?: number;
}

export interface TradeRow {
  order_id?: string;
  status?: string;
  side?: string;
  price?: number | string;
  quantity?: number | string;
  created_at?: string;
}

/** One order row from the by-request lookup (authoritative order status). */
export interface OrderRow {
  orderId?: string;
  requestId?: string;
  symbol?: string;
  side?: string;
  status?: string;
  price?: number;
  /** Remaining (unfilled) quantity. */
  quantity?: number;
  /** Original order quantity (remaining < original ⇒ partial fill). */
  originalQuantity?: number;
  createdAt?: string;
  /**
   * Which by-request bucket the server returned this row in. `false` (from
   * `inactive_orders`) means the order is TERMINAL server-side no matter what
   * its `status` string says — an expired partial fill keeps status
   * "partially_filled" forever, which would otherwise normalize back to a live
   * `placed` and leave a ghost order in the store.
   */
  active: boolean;
}

function num(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return typeof n === 'number' && !Number.isNaN(n) ? n : undefined;
}

/**
 * Thin, rate-limited wrapper around the Temple SDK. Every call routes through
 * the AIMD limiter; 429s feed back into it (not treated as hard errors), other
 * ApiErrors become typed TempleApiError throws.
 */
export class TempleSdk {
  private readonly apiBase: string;
  constructor(
    private readonly rl: RateLimiter,
    opts: { network: 'mainnet' | 'testnet'; apiKey: string },
  ) {
    this.apiBase = opts.network === 'testnet' ? 'https://api-testnet.templedigitalgroup.com' : 'https://api.templedigitalgroup.com';
    this.apiKey = opts.apiKey;
  }
  private readonly apiKey: string;

  /**
   * @param feedRateLimit when false, a 429 does NOT back off the shared request
   *   limiter. Set for ORDER creation: its 429 is the account's per-minute ORDER
   *   cap (handled by the order-path cooldown), NOT a general request-rate
   *   problem — feeding it here wrongly halves the shared read rate and chokes
   *   reconcile/balance/book reads to a crawl after a couple of order 429s.
   */
  private async call<T>(fn: () => Promise<T>, feedRateLimit = true): Promise<T> {
    await this.rl.acquire();
    let out: T;
    try {
      out = await fn();
    } catch (e) {
      // Defensive: SDK normally returns error-as-value, but a thrown error
      // (network/axios) is still possible.
      throw toTempleError(e);
    }
    // SDK signals failure by resolving with an error-shaped object (never throws).
    if (isSdkError(out)) {
      // Canton ledger errors carry the message in `error` (a string); REST errors
      // in `message`. Prefer whichever is present.
      const message = typeof out.error === 'string' ? out.error : (out.message ?? 'SDK error');
      const err = new TempleApiError(message, out.status ?? undefined, out.code ?? undefined, out);
      // Back the shared limiter off on a general rate-limit signal only.
      if (err.isRateLimited && feedRateLimit) this.rl.on429(retryAfterMs(out));
      throw err;
    }
    this.rl.onSuccess();
    return out;
  }

  // --- market data ---

  /**
   * Symbol config — the SDK's getSymbolConfig hits the WRONG path
   * (`/api/v1/trading/symbol-config`, 404). The correct one is
   * `/api/trading/symbol-config` (no /v1). Returns minimum_quantity, max_decimals
   * (PRICE decimals), paused, and rate_limit_orders_per_minute. Direct fetch
   * (trading host, X-API-Key — no proxy).
   */
  /** Direct authenticated GET against the trading host (X-API-Key, no proxy). */
  private getJson<T>(path: string): Promise<T> {
    return this.call(async () => {
      const res = await fetch(`${this.apiBase}${path}`, { headers: { 'X-API-Key': this.apiKey, Accept: 'application/json' } });
      if (!res.ok) return { error: true, status: res.status, code: null, message: `${path} HTTP ${res.status}` } as never;
      return (await res.json()) as never;
    });
  }

  /** Direct authenticated POST against the trading host (X-API-Key, no proxy). */
  private postJson<T>(path: string, body: unknown): Promise<T> {
    return this.call(async () => {
      const res = await fetch(`${this.apiBase}${path}`, {
        method: 'POST',
        headers: { 'X-API-Key': this.apiKey, Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) return { error: true, status: res.status, code: null, message: `${path} HTTP ${res.status}` } as never;
      return (await res.json()) as never;
    });
  }

  /**
   * Authoritative order status for our tracked request_ids (POST
   * /api/trading/orders/by-request). Returns each order's real order_id, status
   * (open/partially_filled/filled/canceled/expired) and remaining vs original
   * quantity — replaces the fragile "match a trade by side+price+ts" heuristic.
   */
  async getOrdersByRequestIds(requestIds: (string | number)[]): Promise<{ active: OrderRow[]; inactive: OrderRow[] }> {
    if (requestIds.length === 0) return { active: [], inactive: [] };
    const ids = requestIds.map((x) => Number(x)).filter((n) => Number.isFinite(n));
    const res = await this.postJson<{ active_orders?: unknown[]; inactive_orders?: unknown[] }>(
      '/api/trading/orders/by-request',
      { request_ids: ids },
    );
    const map = (arr: unknown[] | undefined, active: boolean): OrderRow[] =>
      (arr ?? []).map((raw) => {
        const o = raw as Record<string, unknown>;
        return {
          orderId: o.order_id != null ? String(o.order_id) : undefined,
          requestId: o.request_id != null ? String(o.request_id) : undefined,
          symbol: o.symbol as string | undefined,
          side: typeof o.side === 'string' ? o.side.toLowerCase() : undefined,
          status: typeof o.status === 'string' ? o.status.toLowerCase() : undefined,
          price: num(o.price),
          quantity: num(o.quantity),
          originalQuantity: num(o.original_quantity),
          createdAt: o.created_at as string | undefined,
          active,
        };
      });
    return { active: map(res?.active_orders, true), inactive: map(res?.inactive_orders, false) };
  }

  async getSymbolConfig(symbol: string): Promise<{
    minimum_quantity?: number;
    max_decimals?: number;
    paused?: boolean;
    rate_limit_orders_per_minute?: number | null;
  }> {
    return this.getJson(`/api/trading/symbol-config?symbol=${encodeURIComponent(symbol)}`);
  }

  /** Global health flags. Bot should idle when paused/killswitch. */
  async getStatus(): Promise<{ killswitch?: boolean; tradingPaused?: boolean; depositsPaused?: boolean }> {
    return this.getJson('/api/status');
  }

  /** Oracle USD prices, lowercase keys: { cbtc, cc, usdcx, ... }. */
  async getOracle(): Promise<Record<string, number>> {
    const res = await this.getJson<{ prices?: Record<string, number> }>('/api/crypto/oracle');
    return res?.prices ?? {};
  }

  /** Canton-coin reward totals (the volume-farming goal metric). */
  async getRewards(): Promise<{ rewards?: { total_canton_coin_earned?: number; canton_coin_earned_30d?: number; volume_30d?: number } }> {
    return this.getJson('/api/rewards');
  }

  /** User profile — order count limits + fees. */
  async getProfile(): Promise<{ max_limit_orders?: number; maker_fees?: number; taker_fees?: number; is_onboarded?: boolean }> {
    const res = await this.getJson<{ user?: Record<string, unknown> }>('/api/user/getProfile');
    return (res?.user ?? res) as never;
  }

  /** Recent user trades with per-trade settlement status (pending → settling → settled). */
  async getRecentUserTrades(limit = 200): Promise<TradeRow[]> {
    const res = await this.getJson<{ trades?: TradeRow[] }>(`/api/trading/trades?limit=${limit}`);
    return res?.trades ?? [];
  }

  async getBookTop(symbol: string): Promise<BookTop> {
    const res = await this.call(() => temple.getOrderBook(symbol, { levels: 1 }));
    // Response is wrapped: { orderbook: { best_bid, best_ask, bids, asks } }.
    // Tolerate a flat shape too.
    const book = res?.orderbook ?? res ?? {};
    const bestBid = num(book.best_bid) ?? num(book.bids?.[0]?.price);
    const bestAsk = num(book.best_ask) ?? num(book.asks?.[0]?.price);
    return { bestBid, bestAsk };
  }

  // --- trading ---

  /**
   * Place a limit order. The server returns `request_id` (an int tracking id) —
   * NOT an order_id. The order_id is resolved later from getActiveOrders by
   * matching this request_id. Returns the request_id as a string.
   */
  async placeLimit(opts: {
    symbol: string;
    side: 'buy' | 'sell';
    quantity: number;
    price: number;
    orderType?: 'limit' | 'market';
    postOnly?: boolean;
    expiresAt?: string;
  }): Promise<string> {
    const orderType = opts.orderType ?? 'limit';
    // post_only is a maker-only guarantee — incompatible with a market (taker) order.
    const postOnly = orderType === 'market' ? false : opts.postOnly;
    const res = await this.call(
      () =>
        temple.createOrderRequest({
          symbol: opts.symbol,
          side: opts.side,
          quantity: opts.quantity,
          price: opts.price,
          order_type: orderType,
          ...(postOnly ? { order_subtype: 'post_only' } : {}),
          ...(opts.expiresAt ? { expires_at: opts.expiresAt } : {}),
        }),
      false, // order 429 = account order cap → handled by cooldown, don't throttle reads
    );
    const reqId = res?.request_id ?? res?.requestId;
    if (reqId === undefined || reqId === null) {
      throw new TempleApiError('createOrderRequest returned no request_id');
    }
    return String(reqId);
  }

  async cancelOrder(orderId: string) {
    return this.call(() => temple.cancelOrder(orderId));
  }

  async cancelAll(symbol?: string) {
    return this.call(() => temple.cancelAllOrders(symbol ? { symbol } : undefined));
  }

  /** Active (on-book) orders, normalized to a flat array. */
  async getActiveOrders(symbol?: string): Promise<temple.ActiveOrder[]> {
    const res = await this.call(() => temple.getActiveOrders(symbol ? { symbol } : undefined));
    if (Array.isArray(res)) return res;
    return res?.orders ?? [];
  }

  async getTradingBalance(): Promise<Record<string, number>> {
    const res = await this.call(() => temple.getTradingBalance());
    const list = res?.balances ?? (Array.isArray(res) ? res : []);
    const out: Record<string, number> = {};
    for (const b of list) {
      out[b.asset] = num(b.unlocked) ?? num(b.available_balance) ?? num(b.available) ?? 0;
    }
    return out;
  }

  /** Per-asset trading balance with settlement detail (unlocked/locked/in_flight). */
  async getTradingBalanceDetailed(): Promise<Record<string, { unlocked: number; locked: number; inFlight: number }>> {
    const res = await this.call(() => temple.getTradingBalance());
    const list = res?.balances ?? (Array.isArray(res) ? res : []);
    const out: Record<string, { unlocked: number; locked: number; inFlight: number }> = {};
    for (const b of list) {
      out[b.asset] = {
        unlocked: num(b.unlocked) ?? num(b.available_balance) ?? 0,
        locked: num(b.locked) ?? 0,
        inFlight: num(b.in_flight) ?? num(b.inFlight) ?? 0,
      };
    }
    return out;
  }

  // --- wallet-aware ---

  async getWalletBalances(party?: string): Promise<Record<string, number>> {
    const res = await this.call(() => temple.getUserBalances(party));
    const list = Array.isArray(res) ? res : (res?.balances ?? []);
    const out: Record<string, number> = {};
    for (const b of list) {
      // Wallet entries carry both on-chain `asset` ("Amulet") and normalized
      // `symbol` ("CC"). Key by the normalized symbol so CC/USDA/CBTC line up
      // with trading-balance and config symbols.
      const key = b.symbol ?? b.asset;
      if (!key) continue;
      out[key] = num(b.available_balance) ?? num(b.total_balance) ?? 0;
    }
    return out;
  }

  async deposit(amount: number, symbol: string) {
    return this.call(() => temple.deposit(amount, symbol));
  }

  /**
   * Withdraw an asset from the trading balance back to the Loop wallet. Uses the
   * SDK's high-level flow (create request → poll status → exercise
   * Allocation_Withdraw on the ledger to release holdings). Needs the wallet
   * adapter set (like deposit) — route through the orchestrator's wallet path.
   * Only unlocked balance can be withdrawn; one in-flight withdrawal per asset.
   */
  async withdraw(assetId: string, amount: number | string) {
    return this.call(() => temple.withdrawFunds({ asset_id: assetId, amount: String(amount) }));
  }

  async isOnboarded(party: string): Promise<boolean> {
    const d = await this.call(() => temple.isUserOnboarded(party));
    return Boolean(d);
  }

  async onboard(party: string): Promise<{ warning?: string }> {
    return this.call(() => temple.onboardUser({ partyId: party }));
  }

  get rateStats() {
    return this.rl.stats;
  }
}
