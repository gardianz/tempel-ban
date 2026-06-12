import { isLive, type NormalizedStatus } from './status.js';

export interface DepositPolicyInput {
  /** Current tracked orders' normalized statuses. */
  orders: { status: NormalizedStatus }[];
  /** Trigger when unsettled count <= this. */
  remainingThresholdN: number;
}

/** Count orders not yet settled (pending or settling). */
export function countUnsettled(orders: { status: NormalizedStatus }[]): number {
  return orders.filter((o) => isLive(o.status)).length;
}

/**
 * Decide whether to refill via auto-deposit. True when there is nothing left
 * to fund new orders against — i.e. unsettled order count has dropped to or
 * below the configured threshold (0 means "wait for everything to settle").
 */
export function shouldDeposit(input: DepositPolicyInput): boolean {
  return countUnsettled(input.orders) <= input.remainingThresholdN;
}
