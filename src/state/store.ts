import { EventEmitter } from 'node:events';
import type { NormalizedStatus } from '../core/status.js';
import type { PairState, Side, TrackedOrder } from '../types.js';

export type StoreEvent =
  | { type: 'order:placed'; order: TrackedOrder }
  | { type: 'order:updated'; order: TrackedOrder; prev: NormalizedStatus }
  | { type: 'order:settled'; order: TrackedOrder }
  | { type: 'order:cancelled'; order: TrackedOrder }
  | { type: 'deposit'; asset: string; amount: number; ok: boolean; ccFee?: number }
  | { type: 'pair'; symbol: string }
  | { type: 'rate'; rate: number; count429: number }
  | { type: 'info'; scope: string; message: string }
  | { type: 'error'; scope: string; message: string };

export interface Counters {
  volumeQuote: number;
  ordersPlaced: number;
  ordersSettled: number;
  ordersCancelled: number;
  count429: number;
  startedAt: number;
}

/** One successful deposit, for today/this-month roll-ups. */
export interface DepositRecord {
  ts: number;
  asset: string;
  amount: number;
  /** CC gas burned to make the deposit (0 when none was due). */
  ccFee: number;
}

const RING = 200;
const DEPOSIT_RING = 5000;

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
    ordersCancelled: 0,
    count429: 0,
    startedAt: Date.now(),
  };
  /** Running sum + count of pending→settled durations (for the average). */
  private settleMsSum = 0;
  private settleMsCount = 0;
  /** Running sum + count of gaps between consecutive PLACED orders (actual pacing). */
  private placedGapSumMs = 0;
  private placedGapCount = 0;
  private lastPlacedAt = 0;
  /** Successful deposits (bounded ring) for today/this-month totals. */
  private readonly deposits: DepositRecord[] = [];
  rate = 0;
  /** Global exchange health — true when killswitch/tradingPaused; workers idle. */
  tradingHalted = false;
  /** User-initiated pause (Telegram /stop). Workers stop placing; process stays up. */
  userPaused = false;
  /** Canton-coin rewards (volume-farming goal). */
  ccEarnedTotal?: number;
  ccEarned30d?: number;
  /** 30d quote volume (from /api/rewards) — drives the per-order reward estimate. */
  volume30d?: number;
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
    // An order adopted already-filled (pending/settling) starts its settle clock now.
    if ((order.status === 'pending' || order.status === 'settling') && !order.pendingAt) {
      order.pendingAt = order.placedAt;
    }
    this.orders.set(order.requestId, order);
    if (adopted) return;
    // Measure the real gap between consecutive placements (vs the target spacing).
    if (this.lastPlacedAt > 0) {
      this.placedGapSumMs += order.placedAt - this.lastPlacedAt;
      this.placedGapCount += 1;
    }
    this.lastPlacedAt = order.placedAt;
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
    const now = Date.now();
    order.updatedAt = now;

    // First fill (placed → pending/settling) starts the settle clock.
    if ((status === 'pending' || status === 'settling') && !order.pendingAt) {
      order.pendingAt = now;
    }

    if (status === 'settled') {
      // Terminal + fully settled → counts as volume.
      const notional = order.price * order.quantity;
      this.counters.ordersSettled += 1;
      this.counters.volumeQuote += notional;
      // Time from first fill to settled (fall back to placedAt if never seen pending).
      order.settleMs = now - (order.pendingAt ?? order.placedAt);
      this.settleMsSum += order.settleMs;
      this.settleMsCount += 1;
      // Estimated CC reward: this order's quote notional × (30d CC earned / 30d volume).
      if (this.volume30d && this.volume30d > 0 && this.ccEarned30d) {
        order.estRewardCc = notional * (this.ccEarned30d / this.volume30d);
      }
      const p = this.pairs.get(order.symbol);
      if (p) p.ordersSettled += 1;
      this.orders.delete(requestId);
      this.emitEvent({ type: 'order:settled', order });
      return;
    }
    if (status === 'cancelled') {
      // Terminal, no fill → no volume.
      this.counters.ordersCancelled += 1;
      this.orders.delete(requestId);
      this.emitEvent({ type: 'order:cancelled', order });
      return;
    }
    this.emitEvent({ type: 'order:updated', order, prev });
  }

  markCancelled(requestId: string): void {
    this.updateOrderStatus(requestId, 'cancelled');
  }

  recordDeposit(asset: string, amount: number, ok: boolean, ccFee = 0): void {
    if (ok) {
      this.deposits.push({ ts: Date.now(), asset, amount, ccFee });
      if (this.deposits.length > DEPOSIT_RING) this.deposits.shift();
    }
    this.emitEvent({ type: 'deposit', asset, amount, ok, ccFee });
  }

  setRate(rate: number, count429: number): void {
    this.rate = rate;
    this.counters.count429 = count429;
    this.emitEvent({ type: 'rate', rate, count429 });
  }

  /** Background activity log (informational — rendered normally, not as an error). */
  note(scope: string, message: string): void {
    this.emitEvent({ type: 'info', scope, message });
  }

  recordError(scope: string, message: string): void {
    this.emitEvent({ type: 'error', scope, message });
  }

  /** Average pending→settled time (ms), or undefined when nothing settled yet. */
  get avgSettleMs(): number | undefined {
    return this.settleMsCount > 0 ? this.settleMsSum / this.settleMsCount : undefined;
  }

  /** Average actual gap between placed orders (ms), or undefined with <2 placed. */
  get avgPlacedGapMs(): number | undefined {
    return this.placedGapCount > 0 ? this.placedGapSumMs / this.placedGapCount : undefined;
  }

  /** Fill vs cancel split over all terminal orders this session (0..1). */
  fillStats(): { filled: number; cancelled: number; fillRate: number; cancelRate: number } {
    const filled = this.counters.ordersSettled;
    const cancelled = this.counters.ordersCancelled;
    const total = filled + cancelled;
    return {
      filled,
      cancelled,
      fillRate: total > 0 ? filled / total : 0,
      cancelRate: total > 0 ? cancelled / total : 0,
    };
  }

  /**
   * Deposit + CC-fee totals for today and this calendar month (local time).
   * `today`/`month` are per-asset deposited amounts; `*CcFee` is total CC gas burned.
   */
  depositTotals(): {
    today: Record<string, number>;
    month: Record<string, number>;
    todayCcFee: number;
    monthCcFee: number;
  } {
    const now = new Date();
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const today: Record<string, number> = {};
    const month: Record<string, number> = {};
    let todayCcFee = 0;
    let monthCcFee = 0;
    for (const d of this.deposits) {
      if (d.ts >= monthStart) {
        month[d.asset] = (month[d.asset] ?? 0) + d.amount;
        monthCcFee += d.ccFee;
        if (d.ts >= dayStart) {
          today[d.asset] = (today[d.asset] ?? 0) + d.amount;
          todayCcFee += d.ccFee;
        }
      }
    }
    return { today, month, todayCcFee, monthCcFee };
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
