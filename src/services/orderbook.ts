import { subscribeOrderbook } from '@temple-digital-group/temple-canton-js';

const num = (v: unknown): number => {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return typeof n === 'number' && !Number.isNaN(n) ? n : 0;
};

export interface BookLevel {
  price: number;
  qty: number;
}

export interface BookTop {
  bestBid?: number;
  bestAsk?: number;
  /** Top-N bid prices, highest first. */
  bids: number[];
  /** Top-N ask prices, lowest first. */
  asks: number[];
  /** Top-N bid levels (price+size), highest first — for the depth ladder. */
  bidLevels: BookLevel[];
  /** Top-N ask levels (price+size), lowest first. */
  askLevels: BookLevel[];
  ts: number;
}

const TOP_N = 5;

/**
 * Maintains a live L2 order book from the WebSocket feed (real-time top-of-book,
 * no REST polling lag). The server pushes a `snapshot` then incremental
 * `update` messages ({ side, price, quantity }, quantity 0 = level removed).
 * Best bid = highest bid price, best ask = lowest ask price.
 */
export class LiveOrderbook {
  private readonly bids = new Map<number, number>(); // price -> quantity
  private readonly asks = new Map<number, number>();
  private readonly unsub: () => void;
  readonly top: BookTop = { ts: 0, bids: [], asks: [], bidLevels: [], askLevels: [] };

  constructor(symbol: string, private readonly onUpdate?: (top: BookTop) => void) {
    this.unsub = subscribeOrderbook(symbol, (d: unknown) => this.apply(d as Record<string, unknown>));
  }

  private apply(d: Record<string, unknown>): void {
    const type = String(d.type ?? '');
    if (type === 'snapshot') {
      this.bids.clear();
      this.asks.clear();
      for (const b of (d.bids as Record<string, unknown>[]) ?? []) this.set(this.bids, b);
      for (const a of (d.asks as Record<string, unknown>[]) ?? []) this.set(this.asks, a);
    } else if (type === 'update') {
      const side = String(d.side ?? '').toLowerCase();
      const book = side === 'ask' || side === 'sell' ? this.asks : this.bids;
      const price = num(d.price);
      const qty = num(d.quantity);
      if (price <= 0) return;
      if (qty <= 0) book.delete(price);
      else book.set(price, qty);
    } else {
      return; // unknown message type
    }
    this.recompute();
  }

  private set(book: Map<number, number>, lvl: Record<string, unknown>): void {
    const price = num(lvl.price);
    const qty = num(lvl.quantity);
    if (price > 0 && qty > 0) book.set(price, qty);
  }

  private recompute(): void {
    // Top-N bids (highest first) and asks (lowest first).
    const bids = [...this.bids.keys()].filter((p) => p > 0).sort((a, b) => b - a).slice(0, TOP_N);
    const asks = [...this.asks.keys()].filter((p) => p > 0).sort((a, b) => a - b).slice(0, TOP_N);
    this.top.bids = bids;
    this.top.asks = asks;
    this.top.bidLevels = bids.map((price) => ({ price, qty: this.bids.get(price) ?? 0 }));
    this.top.askLevels = asks.map((price) => ({ price, qty: this.asks.get(price) ?? 0 }));
    this.top.bestBid = bids[0];
    this.top.bestAsk = asks[0];
    this.top.ts = Date.now();
    this.onUpdate?.(this.top);
  }

  close(): void {
    this.unsub?.();
  }
}
