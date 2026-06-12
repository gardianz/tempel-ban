import { isResting, type NormalizedStatus } from './status.js';

export interface RequoteInput {
  status: NormalizedStatus;
  /** Age of the order since placement, ms. */
  ageMs: number;
  /** Time-to-live before re-quote, ms. */
  ttlMs: number;
}

/**
 * Re-quote (cancel + replace at fresh best price) only when an order is still
 * resting on the book AND has out-lived its TTL. Orders that are settling or
 * settled are never touched.
 */
export function shouldRequote(input: RequoteInput): boolean {
  return isResting(input.status) && input.ageMs >= input.ttlMs;
}
