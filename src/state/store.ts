import { EventEmitter } from 'node:events';
import type { NormalizedStatus } from '../core/status.js';
import type { PairState, Side, TrackedOrder } from '../types.js';

export type StoreEvent =
  | { type: 'order:placed'; order: TrackedOrder }
  | { type: 'order:updated'; order: TrackedOrder; prev: NormalizedStatus }
  | { type: 'order:settled'; order: TrackedOrder }
  | { type: 'order:cancelled'; order: TrackedOrder }
  | { type: 'deposit'; asset: string; amount: number; ok: boolean }
  | { type: 'pair'; symbol: string }
  | { type: 'rate'; rate: number; count429: number }
  | { type: 'error'; scope: string; message: string };

export interface Counters {
  volumeQuote: number;
  ordersPlaced: number;
  ordersSettled: number;
  count429: number;
  startedAt: number;
}

const RING = 200;

/**
 * Single in-memory source of truth for dashboard + telegram. Mutating methods
 * emit a typed 'event' so consumers can react without polling. Order history is
 * a bounded ring buffer (state is reconstructed from the API on restart).
 */
export class Store extends EventEmitter {
  readonly pairs = new Map<string, PairState>();
  readonly orders = new Map<string, TrackedOrder>();
  private readonly log: TrackedOrder[] = [];
  readonly counters: Counters = {
    volumeQuote: 0,
    ordersPlaced: 0,
    ordersSettled: 0,
    count429: 0,
    startedAt: Date.now(),
  };
  rate = 0;
  /** Server-advertised rate limit (x-ratelimit-limit) and remaining. */
  serverRateLimit?: number;
  serverRateRemaining?: number;
  /** Global exchange health — true when killswitch/tradingPaused; workers idle. */
  tradingHalted = false;
  /** Canton-coin rewards (volume-farming goal). */
  ccEarnedTotal?: number;
  ccEarned30d?: number;
  /** Oracle USD prices (lowercase keys: cbtc, cc, usdcx) for USD valuation. */
  oraclePrices: Record<string, number> = {};
  /** Live WebSocket top-of-book per symbol (real-time, no REST lag). */
  liveBooks: Record<string, { bestBid?: number; bestAsk?: number; bids: number[]; asks: number[]; ts: number }> = {};
  /** Account order-count cap (max_limit_orders) for "auto" sizing. */
  maxLimitOrders?: number;
  makerFees?: number;
  takerFees?: number;

  network = '';
  walletParty = '';
  walletBalances: Record<string, number> = {};
  tradingBalances: Record<string, number> = {};
  /** Full trading balance detail per asset (unlocked/locked/in-flight). */
  tradingDetailed: Record<string, { unlocked: number; locked: number; inFlight: number }> = {};

  /** Live order counts by lifecycle bucket (computed from the order map). */
  orderCounts(): { placed: number; pending: number; settling: number } {
    let placed = 0;
    let pending = 0;
    let settling = 0;
    for (const o of this.orders.values()) {
      if (o.status === 'placed') placed++;
      else if (o.status === 'pending') pending++;
      else if (o.status === 'settling') settling++;
    }
    return { placed, pending, settling };
  }

  private emitEvent(e: StoreEvent): void {
    this.emit('event', e);
  }

  initPair(symbol: string, side: Side | 'auto'): void {
    this.pairs.set(symbol, {
      symbol,
      side,
      paused: false,
      ordersPlaced: 0,
      ordersSettled: 0,
    });
  }

  patchPair(symbol: string, patch: Partial<PairState>): void {
    const p = this.pairs.get(symbol);
    if (!p) return;
    Object.assign(p, patch);
    this.emitEvent({ type: 'pair', symbol });
  }

  /**
   * Track an order. `adopted` = loaded from the exchange at startup (a prior
   * session's order) — it does not count as newly placed nor log a PLACED event.
   */
  addOrder(order: TrackedOrder, adopted = false): void {
    this.orders.set(order.requestId, order);
    if (adopted) return;
    this.pushLog(order);
    this.counters.ordersPlaced += 1;
    const p = this.pairs.get(order.symbol);
    if (p) p.ordersPlaced += 1;
    this.emitEvent({ type: 'order:placed', order });
  }

  /** Attach the resolved on-chain order_id to a tracked (request_id) order. */
  resolveOrderId(requestId: string, orderId: string): void {
    const order = this.orders.get(requestId);
    if (order && !order.orderId) order.orderId = orderId;
  }

  /** Apply a status update (by request_id); emits settled/updated, rolls counters. */
  updateOrderStatus(requestId: string, status: NormalizedStatus): void {
    const order = this.orders.get(requestId);
    if (!order) return;
    const prev = order.status;
    if (prev === status) return;
    order.status = status;
    order.updatedAt = Date.now();

    if (status === 'settled') {
      // Terminal + fully settled → counts as volume.
      this.counters.ordersSettled += 1;
      this.counters.volumeQuote += order.price * order.quantity;
      const p = this.pairs.get(order.symbol);
      if (p) p.ordersSettled += 1;
      this.orders.delete(requestId);
      this.emitEvent({ type: 'order:settled', order });
      return;
    }
    if (status === 'cancelled') {
      // Terminal, no fill → no volume.
      this.orders.delete(requestId);
      this.emitEvent({ type: 'order:cancelled', order });
      return;
    }
    this.emitEvent({ type: 'order:updated', order, prev });
  }

  markCancelled(requestId: string): void {
    this.updateOrderStatus(requestId, 'cancelled');
  }

  recordDeposit(asset: string, amount: number, ok: boolean): void {
    this.emitEvent({ type: 'deposit', asset, amount, ok });
  }

  setRate(rate: number, count429: number): void {
    this.rate = rate;
    this.counters.count429 = count429;
    this.emitEvent({ type: 'rate', rate, count429 });
  }

  recordError(scope: string, message: string): void {
    this.emitEvent({ type: 'error', scope, message });
  }

  ordersForPair(symbol: string): TrackedOrder[] {
    return [...this.orders.values()].filter((o) => o.symbol === symbol);
  }

  /** Reverse lookup: resolved order_id -> our request_id tracking key. */
  findRequestIdByOrderId(orderId: string): string | undefined {
    for (const o of this.orders.values()) {
      if (o.orderId === orderId) return o.requestId;
    }
    return undefined;
  }

  recentLog(n = 50): TrackedOrder[] {
    return this.log.slice(-n).reverse();
  }

  get uptimeMs(): number {
    return Date.now() - this.counters.startedAt;
  }

  private pushLog(order: TrackedOrder): void {
    this.log.push(order);
    if (this.log.length > RING) this.log.shift();
  }
}
