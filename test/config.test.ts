import { describe, it, expect } from 'vitest';
import { configSchema, envSchema } from '../src/config/schema.js';
import { budgetFor } from '../src/config/index.js';

describe('configSchema', () => {
  it('applies defaults', () => {
    const c = configSchema.parse({ pairs: [{ symbol: 'CC/USDA' }], budgetPerOrder: 100 });
    expect(c.orderTtlMinutes).toBe(10);
    expect(c.onBelowMin).toBe('bump');
    expect(c.pairs[0]!.side).toBe('auto');
    expect(c.pairs[0]!.enabled).toBe(true);
  });

  it('rejects bad symbol format', () => {
    expect(configSchema.safeParse({ pairs: [{ symbol: 'CCUSDA' }], budgetPerOrder: 100 }).success).toBe(false);
  });

  it('rejects maxRate < rate', () => {
    const r = configSchema.safeParse({ pairs: [{ symbol: 'CC/USDA' }], budgetPerOrder: 100, ratePerMinute: 60, maxRatePerMinute: 30 });
    expect(r.success).toBe(false);
  });

  it('requires at least one pair', () => {
    expect(configSchema.safeParse({ pairs: [], budgetPerOrder: 100 }).success).toBe(false);
  });

  it('maxOpenOrders accepts "auto" (default) or a positive number', () => {
    const def = configSchema.parse({ pairs: [{ symbol: 'CC/USDA' }], budgetPerOrder: 100 });
    expect(def.maxOpenOrders).toBe('auto');
    expect(configSchema.parse({ pairs: [{ symbol: 'CC/USDA' }], budgetPerOrder: 100, maxOpenOrders: 25 }).maxOpenOrders).toBe(25);
    expect(configSchema.safeParse({ pairs: [{ symbol: 'CC/USDA' }], budgetPerOrder: 100, maxOpenOrders: 0 }).success).toBe(false);
  });
});

describe('envSchema', () => {
  it('requires api key, private key, network', () => {
    expect(envSchema.safeParse({}).success).toBe(false);
    expect(
      envSchema.safeParse({ TEMPLE_API_KEY: 'k', LOOP_PRIVATE_KEY: 'p', LOOP_PARTY_ID: 'a::b', NETWORK: 'testnet' }).success,
    ).toBe(true);
  });
  it('rejects invalid network', () => {
    expect(envSchema.safeParse({ TEMPLE_API_KEY: 'k', LOOP_PRIVATE_KEY: 'p', LOOP_PARTY_ID: 'a::b', NETWORK: 'devnet' }).success).toBe(false);
  });
});

describe('budgetFor', () => {
  const base = configSchema.parse({ pairs: [{ symbol: 'CC/USDA' }], budgetPerOrder: 100 });
  it('uses global budget by default', () => {
    expect(budgetFor(base, base.pairs[0]!)).toBe(100);
  });
  it('uses per-pair override', () => {
    const c = configSchema.parse({ pairs: [{ symbol: 'CC/USDA', budgetPerOrder: 250 }], budgetPerOrder: 100 });
    expect(budgetFor(c, c.pairs[0]!)).toBe(250);
  });
});
