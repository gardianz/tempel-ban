/**
 * Five lifecycle states the bot tracks (matches the Temple UI / reference bot):
 *  - placed:    resting on the book, not (fully) filled. Re-quotable.
 *  - pending:   filled — the resulting trade is awaiting settlement (status pending).
 *  - settling:  trade settlement in progress (status settling).
 *  - settled:   trade fully settled (terminal, counts as volume).
 *  - cancelled: left the book without a fill (terminal, no volume).
 */
export type NormalizedStatus = 'placed' | 'pending' | 'settling' | 'settled' | 'cancelled';

/** True for terminal states (removed from the live order map). */
export function isTerminal(status: NormalizedStatus): boolean {
  return status === 'settled' || status === 'cancelled';
}

/** Live (not-yet-finished) states the deposit/flip logic waits on. */
export function isLive(status: NormalizedStatus): boolean {
  return !isTerminal(status);
}

/**
 * Raw order/trade status strings we recognize. Server-defined values aren't
 * documented (api types only say `status: string`); anything else hits the
 * fallback and is surfaced via `isKnownStatus` for calibration.
 */
export const KNOWN_RAW_STATUSES = new Set([
  'open', 'new', 'accepted', 'placed', 'partially_filled', 'partial',
  'pending', 'filled', 'matched', 'filling', 'pending_settlement',
  'settling',
  'settled', 'completed', 'closed',
  'cancelled', 'canceled', 'expired', 'rejected', 'failed',
]);

/** False when `raw` is not in KNOWN_RAW_STATUSES (i.e. it hit the fallback). */
export function isKnownStatus(raw: string): boolean {
  return KNOWN_RAW_STATUSES.has(raw.trim().toLowerCase());
}

/**
 * Normalize a raw ORDER status (from the active-orders API / WebSocket) into a
 * lifecycle state. Order status only distinguishes resting / filled / terminal;
 * the finer pending→settling→settled split comes from TRADE status via
 * `settlementBucket`.
 */
export function normalizeStatus(raw: string): NormalizedStatus {
  switch (raw.trim().toLowerCase()) {
    case 'open':
    case 'new':
    case 'accepted':
    case 'placed':
    case 'partially_filled':
    case 'partial':
      return 'placed';

    // Filled — settlement not yet confirmed.
    case 'filled':
    case 'matched':
    case 'filling':
    case 'pending':
    case 'pending_settlement':
      return 'pending';

    case 'settling':
      return 'settling';

    case 'settled':
    case 'completed':
    case 'closed':
      return 'settled';

    case 'cancelled':
    case 'canceled':
    case 'expired':
    case 'rejected':
    case 'failed':
      return 'cancelled';

    default:
      return 'placed';
  }
}

/**
 * Collapse a filled order's TRADE statuses into its settlement state.
 * Progression pending → settling → settled (mirrors the reference bot):
 *  - all settled       → settled
 *  - any still pending → pending
 *  - otherwise         → settling
 */
export function settlementBucket(tradeStatuses: string[]): 'pending' | 'settling' | 'settled' {
  const s = tradeStatuses.map((x) => x.trim().toLowerCase());
  if (s.length > 0 && s.every((x) => x === 'settled')) return 'settled';
  if (s.some((x) => x === 'pending')) return 'pending';
  return 'settling';
}

/** Resting orders are the only ones eligible for cancel + re-quote. */
export function isResting(status: NormalizedStatus): boolean {
  return status === 'placed';
}
