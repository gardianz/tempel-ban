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
}

function toTempleError(e: unknown): TempleApiError {
  const err = e as { status?: number; code?: string | number; message?: string };
  return new TempleApiError(err?.message ?? String(e), err?.status, err?.code, e);
}

/** The SDK signals failure by RESOLVING with this shape (it never throws). */
interface SdkError {
  error: true;
  status: number | null;
  code: string | number | null;
  message: string;
  retry_after?: number;
}
function isSdkError(v: unknown): v is SdkError {
  return Boolean(v) && typeof v === 'object' && (v as { error?: unknown }).error === true;
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

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    await this.rl.acquire();
    let out: T;
    try {
      out = await fn();
    } catch (e) {
      // Defensive: SDK normally returns error-as-value, but a thrown error
      // (network/axios) is still possible.
      throw toTempleError(e);
    }
    // SDK signals failure by resolving with { error:true, status, code, message }.
    if (isSdkError(out)) {
      if (out.status === 429) {
        this.rl.on429(retryAfterMs(out));
      }
      throw new TempleApiError(out.message, out.status ?? undefined, out.code ?? undefined, out);
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
    const res = await this.call(() =>
      temple.createOrderRequest({
        symbol: opts.symbol,
        side: opts.side,
        quantity: opts.quantity,
        price: opts.price,
        order_type: orderType,
        ...(postOnly ? { order_subtype: 'post_only' } : {}),
        ...(opts.expiresAt ? { expires_at: opts.expiresAt } : {}),
      }),
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
