import { describe, it, expect } from 'vitest';
import { Store } from '../src/state/store.js';
import type { TrackedOrder } from '../src/types.js';

function order(requestId: string): TrackedOrder {
  return {
    requestId,
    symbol: 'CBTC/USDA',
    side: 'buy',
    price: 60000,
    quantity: 0.0001,
    status: 'placed',
    placedAt: Date.now(),
    updatedAt: Date.now(),
  };
}

describe('Store 5-state lifecycle', () => {
  it('placed/pending/settling are live (kept); only settled/cancelled remove', () => {
    const s = new Store();
    s.initPair('CBTC/USDA', 'buy');
    s.addOrder(order('1'));
    s.updateOrderStatus('1', 'pending'); // filled, awaiting settlement
    expect(s.orders.has('1')).toBe(true);
    s.updateOrderStatus('1', 'settling');
    expect(s.orders.has('1')).toBe(true);
    expect(s.orderCounts()).toEqual({ placed: 0, pending: 0, settling: 1 });
  });

  it('settled counts volume + removes; cancelled removes with NO volume', () => {
    const s = new Store();
    s.initPair('CBTC/USDA', 'buy');
    s.addOrder(order('1'));
    s.addOrder(order('2'));
    s.updateOrderStatus('1', 'settled');
    expect(s.orders.has('1')).toBe(false);
    expect(s.counters.ordersSettled).toBe(1);
    expect(s.counters.volumeQuote).toBeCloseTo(60000 * 0.0001);
    s.markCancelled('2');
    expect(s.orders.has('2')).toBe(false);
    expect(s.counters.ordersSettled).toBe(1); // cancel adds no settled/volume
    expect(s.counters.volumeQuote).toBeCloseTo(60000 * 0.0001);
  });

  it('orderCounts buckets placed/pending/settling', () => {
    const s = new Store();
    s.initPair('CBTC/USDA', 'buy');
    s.addOrder(order('1')); // placed
    s.addOrder(order('2'));
    s.updateOrderStatus('2', 'pending');
    s.addOrder(order('3'));
    s.updateOrderStatus('3', 'settling');
    expect(s.orderCounts()).toEqual({ placed: 1, pending: 1, settling: 1 });
  });

  it('resolveOrderId attaches order_id for cancel', () => {
    const s = new Store();
    s.initPair('CBTC/USDA', 'buy');
    s.addOrder(order('1'));
    s.resolveOrderId('1', 'ord_abc');
    expect(s.orders.get('1')?.orderId).toBe('ord_abc');
    expect(s.findRequestIdByOrderId('ord_abc')).toBe('1');
  });
});
