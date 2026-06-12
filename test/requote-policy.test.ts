import { describe, it, expect } from 'vitest';
import { shouldRequote } from '../src/core/requote-policy.js';

describe('shouldRequote', () => {
  it('true when resting (placed) and age >= ttl', () => {
    expect(shouldRequote({ status: 'placed', ageMs: 1000, ttlMs: 1000 })).toBe(true);
    expect(shouldRequote({ status: 'placed', ageMs: 1500, ttlMs: 1000 })).toBe(true);
  });
  it('false when resting but age < ttl', () => {
    expect(shouldRequote({ status: 'placed', ageMs: 999, ttlMs: 1000 })).toBe(false);
  });
  it('false for filled (pending/settling) regardless of age', () => {
    expect(shouldRequote({ status: 'pending', ageMs: 99999, ttlMs: 1000 })).toBe(false);
    expect(shouldRequote({ status: 'settling', ageMs: 99999, ttlMs: 1000 })).toBe(false);
  });
  it('false for settled regardless of age', () => {
    expect(shouldRequote({ status: 'settled', ageMs: 99999, ttlMs: 1000 })).toBe(false);
  });
});
