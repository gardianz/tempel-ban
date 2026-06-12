import { describe, it, expect } from 'vitest';
import { normalizeStatus, isResting, isKnownStatus, settlementBucket, isLive, isTerminal } from '../src/core/status.js';

describe('normalizeStatus', () => {
  it.each(['open', 'new', 'accepted', 'placed', 'PARTIALLY_FILLED', 'partial'])(
    'maps %s -> placed (resting)',
    (raw) => expect(normalizeStatus(raw)).toBe('placed'),
  );

  it.each(['filled', 'matched', 'filling', 'pending', 'pending_settlement'])(
    'maps %s -> pending (filled, awaiting settlement)',
    (raw) => expect(normalizeStatus(raw)).toBe('pending'),
  );

  it('maps settling -> settling', () => expect(normalizeStatus('settling')).toBe('settling'));

  it.each(['settled', 'completed', 'closed'])('maps %s -> settled', (raw) => expect(normalizeStatus(raw)).toBe('settled'));

  it.each(['cancelled', 'canceled', 'expired', 'rejected', 'failed'])(
    'maps %s -> cancelled',
    (raw) => expect(normalizeStatus(raw)).toBe('cancelled'),
  );

  it('is case-insensitive and trims', () => {
    expect(normalizeStatus('  OPEN ')).toBe('placed');
    expect(normalizeStatus('Settled')).toBe('settled');
  });

  it('unknown values fall back to placed', () => {
    expect(normalizeStatus('weird_status')).toBe('placed');
  });
});

describe('settlementBucket', () => {
  it('all settled -> settled', () => expect(settlementBucket(['settled', 'settled'])).toBe('settled'));
  it('any pending -> pending', () => expect(settlementBucket(['pending', 'settling'])).toBe('pending'));
  it('settling (no pending, not all settled) -> settling', () =>
    expect(settlementBucket(['settling', 'settled'])).toBe('settling'));
  it('empty -> settling (just filled, no trade detail yet)', () => expect(settlementBucket([])).toBe('settling'));
});

describe('isLive / isTerminal', () => {
  it('placed/pending/settling are live; settled/cancelled terminal', () => {
    expect(isLive('placed')).toBe(true);
    expect(isLive('pending')).toBe(true);
    expect(isLive('settling')).toBe(true);
    expect(isTerminal('settled')).toBe(true);
    expect(isTerminal('cancelled')).toBe(true);
  });
});

describe('isKnownStatus', () => {
  it('true for mapped values, case-insensitive', () => {
    expect(isKnownStatus('OPEN')).toBe(true);
    expect(isKnownStatus(' settled ')).toBe(true);
  });
  it('false for uncalibrated/unknown values', () => {
    expect(isKnownStatus('in_settlement')).toBe(false);
    expect(isKnownStatus('weird')).toBe(false);
  });
});

describe('isResting', () => {
  it('only placed is resting (re-quotable)', () => {
    expect(isResting('placed')).toBe(true);
    expect(isResting('pending')).toBe(false);
    expect(isResting('settling')).toBe(false);
    expect(isResting('settled')).toBe(false);
  });
});
