import { describe, it, expect } from 'vitest';
import { shouldDeposit, countUnsettled } from '../src/core/deposit-policy.js';
import type { NormalizedStatus } from '../src/core/status.js';

const ord = (status: NormalizedStatus) => ({ status });

describe('countUnsettled', () => {
  it('counts pending and settling, not settled', () => {
    expect(countUnsettled([ord('pending'), ord('settling'), ord('settled')])).toBe(2);
  });
});

describe('shouldDeposit', () => {
  it('triggers when all settled (threshold 0)', () => {
    expect(shouldDeposit({ orders: [ord('settled'), ord('settled')], remainingThresholdN: 0 })).toBe(true);
  });
  it('does not trigger with 1 unsettled at threshold 0', () => {
    expect(shouldDeposit({ orders: [ord('pending')], remainingThresholdN: 0 })).toBe(false);
  });
  it('triggers exactly at threshold N', () => {
    expect(shouldDeposit({ orders: [ord('pending'), ord('settling')], remainingThresholdN: 2 })).toBe(true);
  });
  it('does not trigger at N+1', () => {
    expect(shouldDeposit({ orders: [ord('pending'), ord('settling'), ord('pending')], remainingThresholdN: 2 })).toBe(false);
  });
  it('empty order set triggers', () => {
    expect(shouldDeposit({ orders: [], remainingThresholdN: 0 })).toBe(true);
  });
});
