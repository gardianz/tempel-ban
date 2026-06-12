export type OnBelowMin = 'bump' | 'skip';

export interface SizeOrderInput {
  /** Notional budget for this order, in quote currency. */
  budgetPerOrder: number;
  /** Price (quote per base) the order will rest at. */
  price: number;
  /** Exchange minimum order quantity (base units). */
  minimumQuantity: number;
  /** Max decimal places allowed for quantity. */
  maxDecimals: number;
  /** What to do when computed qty < minimumQuantity. */
  onBelowMin: OnBelowMin;
}

export type SizeOrderResult = { quantity: number } | { skip: true; reason: string };

/** Floor `value` to `decimals` places without binary-float drift. */
export function floorToDecimals(value: number, decimals: number): number {
  if (decimals < 0) decimals = 0;
  const f = 10 ** decimals;
  // +epsilon guards against e.g. 1.005*100 = 100.49999 floating error.
  return Math.floor(value * f + 1e-9) / f;
}

export interface SizeByQuantityInput {
  /** Desired order size in BASE token units. */
  quantity: number;
  minimumQuantity: number;
  maxDecimals: number;
  onBelowMin: OnBelowMin;
}

/**
 * Size an order by a fixed BASE-token quantity (not a quote notional).
 * Floors to maxDecimals, then clamps to the exchange minimum: if the requested
 * quantity is below the minimum, `bump` uses the minimum, `skip` skips.
 */
export function sizeByQuantity(input: SizeByQuantityInput): SizeOrderResult {
  const { quantity, minimumQuantity, maxDecimals, onBelowMin } = input;
  if (quantity <= 0) return { skip: true, reason: 'non-positive quantity' };

  const qty = floorToDecimals(quantity, maxDecimals);
  if (qty >= minimumQuantity) return { quantity: qty };

  if (onBelowMin === 'bump') return { quantity: minimumQuantity };
  return { skip: true, reason: `quantity ${qty} below minimum ${minimumQuantity}` };
}

/**
 * Compute order quantity from a quote-currency budget and price.
 * Rounds DOWN to maxDecimals (never overspend the budget), then clamps to the
 * exchange minimum. If still below min, `bump` uses the minimum, `skip` skips.
 */
export function sizeOrder(input: SizeOrderInput): SizeOrderResult {
  const { budgetPerOrder, price, minimumQuantity, maxDecimals, onBelowMin } = input;

  if (price <= 0) return { skip: true, reason: 'non-positive price' };
  if (budgetPerOrder <= 0) return { skip: true, reason: 'non-positive budget' };

  const raw = budgetPerOrder / price;
  const qty = floorToDecimals(raw, maxDecimals);

  if (qty >= minimumQuantity) return { quantity: qty };

  if (onBelowMin === 'bump') return { quantity: minimumQuantity };
  return { skip: true, reason: `qty ${qty} below minimum ${minimumQuantity}` };
}
