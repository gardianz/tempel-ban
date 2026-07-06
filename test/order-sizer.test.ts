import { describe, it, expect } from 'vitest';
import { sizeOrder, sizeByQuantity, floorToDecimals, decimalsOf } from '../src/core/order-sizer.js';

describe('decimalsOf', () => {
  it('counts exponent AND mantissa fraction (0.00015 → 5, not 4)', () => {
    expect(decimalsOf(0.0001)).toBe(4);
    expect(decimalsOf(0.00015)).toBe(5);
    expect(decimalsOf(0.00016)).toBe(5);
    expect(decimalsOf(0.0005)).toBe(4);
    expect(decimalsOf(0.001)).toBe(3);
    expect(decimalsOf(1.25)).toBe(2);
    expect(decimalsOf(100)).toBe(0);
    expect(decimalsOf(0)).toBe(0);
  });

  it('does not floor a valid qty below a fractional minimum (regression)', () => {
    // min 0.00015 → 5 decimals; 0.00016 must survive flooring and clear the min.
    const dec = decimalsOf(0.00015);
    const r = sizeByQuantity({ quantity: 0.00016, minimumQuantity: 0.00015, maxDecimals: dec, onBelowMin: 'skip' });
    expect(r).toEqual({ quantity: 0.00016 });
  });
});

describe('floorToDecimals', () => {
  it('floors to given decimals', () => {
    expect(floorToDecimals(1.23789, 2)).toBe(1.23);
    expect(floorToDecimals(100.9999, 0)).toBe(100);
  });
  it('avoids float drift', () => {
    expect(floorToDecimals(1.005, 2)).toBe(1.0);
    expect(floorToDecimals(0.0001, 4)).toBe(0.0001);
  });
});

describe('sizeOrder', () => {
  it('computes qty = budget/price floored to decimals', () => {
    const r = sizeOrder({ budgetPerOrder: 500, price: 2, minimumQuantity: 100, maxDecimals: 2, onBelowMin: 'skip' });
    expect(r).toEqual({ quantity: 250 });
  });

  it('rounds DOWN, never overspends budget', () => {
    // 100/3 = 33.333..., 2 decimals
    const r = sizeOrder({ budgetPerOrder: 100, price: 3, minimumQuantity: 0.0001, maxDecimals: 2, onBelowMin: 'skip' });
    expect(r).toEqual({ quantity: 33.33 });
  });

  it('returns qty when exactly at minimum', () => {
    const r = sizeOrder({ budgetPerOrder: 200, price: 2, minimumQuantity: 100, maxDecimals: 0, onBelowMin: 'skip' });
    expect(r).toEqual({ quantity: 100 });
  });

  it('skips when below minimum and onBelowMin=skip', () => {
    const r = sizeOrder({ budgetPerOrder: 50, price: 2, minimumQuantity: 100, maxDecimals: 0, onBelowMin: 'skip' });
    expect(r).toHaveProperty('skip', true);
  });

  it('bumps to minimum when below minimum and onBelowMin=bump', () => {
    const r = sizeOrder({ budgetPerOrder: 50, price: 2, minimumQuantity: 100, maxDecimals: 0, onBelowMin: 'bump' });
    expect(r).toEqual({ quantity: 100 });
  });

  it('skips on non-positive price or budget', () => {
    expect(sizeOrder({ budgetPerOrder: 100, price: 0, minimumQuantity: 1, maxDecimals: 2, onBelowMin: 'bump' })).toHaveProperty('skip', true);
    expect(sizeOrder({ budgetPerOrder: 0, price: 2, minimumQuantity: 1, maxDecimals: 2, onBelowMin: 'bump' })).toHaveProperty('skip', true);
  });
});

describe('sizeByQuantity (fixed base-token size)', () => {
  it('uses the requested token quantity, floored to decimals', () => {
    expect(sizeByQuantity({ quantity: 100, minimumQuantity: 100, maxDecimals: 0, onBelowMin: 'skip' })).toEqual({ quantity: 100 });
    expect(sizeByQuantity({ quantity: 0.00012345, minimumQuantity: 0.0001, maxDecimals: 4, onBelowMin: 'skip' })).toEqual({ quantity: 0.0001 });
  });

  it('skips below minimum when onBelowMin=skip', () => {
    expect(sizeByQuantity({ quantity: 0.00005, minimumQuantity: 0.0001, maxDecimals: 4, onBelowMin: 'skip' })).toHaveProperty('skip', true);
  });

  it('bumps to minimum when onBelowMin=bump', () => {
    expect(sizeByQuantity({ quantity: 50, minimumQuantity: 100, maxDecimals: 0, onBelowMin: 'bump' })).toEqual({ quantity: 100 });
  });

  it('skips on non-positive quantity', () => {
    expect(sizeByQuantity({ quantity: 0, minimumQuantity: 1, maxDecimals: 0, onBelowMin: 'bump' })).toHaveProperty('skip', true);
  });
});
