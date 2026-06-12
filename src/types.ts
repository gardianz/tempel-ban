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
  /** First time the order was seen gone from the active book (for cancel grace). */
  goneSince?: number;
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
