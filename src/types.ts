import type { NormalizedStatus } from './core/status.js';

export type Side = 'buy' | 'sell';

/** A pair split into its two assets. */
export interface PairAssets {
  base: string;
  quote: string;
}

export function splitPair(symbol: string): PairAssets {
  const [base, quote] = symbol.split('/');
  if (!base || !quote) throw new Error(`bad pair symbol: ${symbol}`);
  return { base, quote };
}

/**
 * USD value of an amount of an asset, using oracle prices (lowercase keys:
 * cbtc, cc, usdcx). Stablecoin quotes (USDA/USDCx/USDC) are treated as 1 USD.
 */
export function usdValue(asset: string, amount: number, prices: Record<string, number>): number {
  const a = asset.toUpperCase();
  if (a === 'USDA' || a === 'USDCX' || a === 'USDC') return amount;
  if (a === 'CBTC') return amount * (prices.cbtc ?? 0);
  if (a === 'CC' || a === 'AMULET') return amount * (prices.cc ?? 0);
  return amount * (prices[a.toLowerCase()] ?? 0);
}

/** The asset spent when placing an order on a given side. */
export function spendAsset(symbol: string, side: Side): string {
  const { base, quote } = splitPair(symbol);
  return side === 'buy' ? quote : base;
}

/**
 * A locally tracked order. Keyed by `requestId` (the int tracking id returned
 * by createOrderRequest). `orderId` is resolved later from getActiveOrders by
 * matching request_id, and is required before the order can be cancelled.
 */
export interface TrackedOrder {
  requestId: string;
  orderId?: string;
  symbol: string;
  side: Side;
  price: number;
  quantity: number;
  status: NormalizedStatus;
  placedAt: number;
  updatedAt: number;
  /** First time the order became filled (pending/settling) — start of the settle clock. */
  pendingAt?: number;
  /** Time taken from first fill (pending) to fully settled, in ms (set on settle). */
  settleMs?: number;
  /** Estimated CC reward this order earned (set on settle, from the 30d reward/volume ratio). */
  estRewardCc?: number;
  /**
   * Actually FILLED base quantity (original − remaining), from the by-request
   * lookup. Used instead of the order size for volume so partial fills don't
   * over-count. Undefined until reconcile observes the order.
   */
  filledQuantity?: number;
  /**
   * When a past-TTL cancel fails (order raced us / momentarily uncancellable),
   * suppress re-quoting THIS order until this timestamp so we don't spam cancel
   * every tick. Reconcile stays the authority that finally clears it.
   */
  requoteBackoffUntil?: number;
  /**
   * Count of consecutive failed re-quote cancels on this order. Drives an
   * exponential backoff so an order that is persistently uncancellable (e.g. a
   * partially-filled order the server won't let us cancel) escalates from a
   * per-tick retry to a rare one, instead of looping forever.
   */
  requoteFailures?: number;
}

/** Per-pair runtime status surfaced to the dashboard. */
export interface PairState {
  symbol: string;
  side: Side | 'auto';
  resolvedSide?: Side;
  paused: boolean;
  bestBid?: number;
  bestAsk?: number;
  lastQty?: number;
  ordersPlaced: number;
  ordersSettled: number;
  /** Live counts for the dashboard. */
  openOrders?: number;
  settlingOrders?: number;
  /** Resolved order rate cap (orders/min, 0 = uncapped) and concurrent cap. */
  orderRate?: number;
  maxOpen?: number;
  note?: string;
}
