import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the untyped Temple SDK module so we can exercise the wrapper's handling
// of error-as-value responses (the SDK resolves errors, it never throws).
const mock = vi.hoisted(() => ({
  createOrderRequest: vi.fn(),
  getOrderBook: vi.fn(),
  getActiveOrders: vi.fn(),
  getTradingBalance: vi.fn(),
}));
vi.mock('@temple-digital-group/temple-canton-js', () => mock);

import { TempleSdk, TempleApiError } from '../src/services/sdk.js';
import { RateLimiter } from '../src/core/ratelimiter.js';

function makeSdk() {
  const rl = new RateLimiter({ ratePerMinute: 60, maxRatePerMinute: 60, sleep: () => Promise.resolve() });
  return { sdk: new TempleSdk(rl, { network: 'mainnet', apiKey: 'test-key' }), rl };
}

beforeEach(() => {
  for (const fn of Object.values(mock)) (fn as ReturnType<typeof vi.fn>).mockReset();
});

describe('error-as-value handling', () => {
  it('throws TempleApiError when SDK resolves {error:true}', async () => {
    const { sdk } = makeSdk();
    mock.getTradingBalance.mockResolvedValue({ error: true, status: 400, code: 'BAD', message: 'nope' });
    await expect(sdk.getTradingBalance()).rejects.toBeInstanceOf(TempleApiError);
  });

  it('feeds 429 into the rate limiter (halves rate) and throws', async () => {
    const { sdk, rl } = makeSdk();
    mock.getActiveOrders.mockResolvedValue({ error: true, status: 429, code: 'RATE', message: 'slow down' });
    const before = rl.currentRate;
    await expect(sdk.getActiveOrders()).rejects.toMatchObject({ is429: true });
    expect(rl.currentRate).toBe(Math.floor(before * 0.5));
  });

  it('treats code 249 as rate-limited and backs the limiter off', async () => {
    const { sdk, rl } = makeSdk();
    mock.getActiveOrders.mockResolvedValue({ error: true, status: 249, code: 249, message: 'rate limit' });
    const before = rl.currentRate;
    await expect(sdk.getActiveOrders()).rejects.toMatchObject({ isRateLimited: true, is429: false });
    expect(rl.currentRate).toBe(Math.floor(before * 0.5));
  });

  it('does NOT treat an ordinary 400 as rate-limited', async () => {
    const { sdk, rl } = makeSdk();
    mock.getActiveOrders.mockResolvedValue({ error: true, status: 400, code: 'BAD', message: 'bad request' });
    const before = rl.currentRate;
    await expect(sdk.getActiveOrders()).rejects.toMatchObject({ isRateLimited: false });
    expect(rl.currentRate).toBe(before); // untouched
  });
});

describe('placeLimit', () => {
  it('returns request_id (createOrder gives no order_id)', async () => {
    const { sdk } = makeSdk();
    mock.createOrderRequest.mockResolvedValue({ success: true, request_id: 4242, message: 'queued' });
    const id = await sdk.placeLimit({ symbol: 'CC/USDA', side: 'buy', quantity: 100, price: 1.2 });
    expect(id).toBe('4242');
  });

  it('throws when no request_id present', async () => {
    const { sdk } = makeSdk();
    mock.createOrderRequest.mockResolvedValue({ success: true, message: 'queued' });
    await expect(sdk.placeLimit({ symbol: 'CC/USDA', side: 'buy', quantity: 100, price: 1.2 })).rejects.toBeInstanceOf(TempleApiError);
  });
});

describe('getBookTop', () => {
  it('unwraps the { orderbook: {...} } envelope', async () => {
    const { sdk } = makeSdk();
    mock.getOrderBook.mockResolvedValue({ orderbook: { best_bid: 1.25, best_ask: 1.26 } });
    expect(await sdk.getBookTop('CC/USDA')).toEqual({ bestBid: 1.25, bestAsk: 1.26 });
  });

  it('falls back to bids/asks arrays and flat shape', async () => {
    const { sdk } = makeSdk();
    mock.getOrderBook.mockResolvedValue({ bids: [{ price: '2.0' }], asks: [{ price: '2.1' }] });
    expect(await sdk.getBookTop('CC/USDA')).toEqual({ bestBid: 2.0, bestAsk: 2.1 });
  });
});

describe('getActiveOrders', () => {
  it('unwraps { orders: [...] }', async () => {
    const { sdk } = makeSdk();
    mock.getActiveOrders.mockResolvedValue({ orders: [{ order_id: 'o1', request_id: 7, status: 'open' }], count: 1 });
    const out = await sdk.getActiveOrders();
    expect(out).toHaveLength(1);
    expect(out[0]!.request_id).toBe(7);
  });
});
