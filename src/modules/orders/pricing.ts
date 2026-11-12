/**
 * Server-side order pricing rules.
 *
 * Single source of truth for the delivery charge, the local-only test-price
 * override and the estimated-delivery window. Pure functions with no I/O so
 * they can be unit-tested and reused by both order creation and the public
 * catalogue serializer.
 *
 * The browser NEVER computes the final charge: createOrder re-prices every
 * line from published DB rows using these rules, so a tampered payload or a
 * crafted API call can never change what is actually charged.
 */

/** Orders at or below this subtotal (in whole rupees) pay the delivery fee. */
export const FREE_DELIVERY_THRESHOLD = 10000;

/** Flat delivery charge in whole rupees applied below the threshold. */
export const STANDARD_DELIVERY_FEE = 110;

/** Token price used by the local-only test override. */
export const TEST_PRICE_AMOUNT = 10;

/** The single product the local-only test override applies to. */
export const TEST_PRICE_SLUG = 'draftox-16-channel';

/** Calendar days added to the order timestamp for the estimated delivery. */
export const ESTIMATED_DELIVERY_DAYS = 15;

/**
 * True only when BOTH a non-production NODE_ENV and an explicit
 * `DEV_TEST_PRICE_ENABLED=true` are present. Read at call time so a test can
 * toggle it. Production can never satisfy this, even with the flag set.
 */
export function testPriceOverrideEnabled(
  nodeEnv: string | undefined = process.env.NODE_ENV,
  flag: string | undefined = process.env.DEV_TEST_PRICE_ENABLED,
): boolean {
  return nodeEnv !== 'production' && flag === 'true';
}

/**
 * Unit price for a line. Applies the token test price to the 16-channel system
 * ONLY when the override is explicitly enabled outside production; every other
 * product (and every production request) uses the catalogue price unchanged.
 */
export function effectiveUnitPrice(slug: string, catalogPrice: number): number {
  if (testPriceOverrideEnabled() && slug === TEST_PRICE_SLUG) return TEST_PRICE_AMOUNT;
  return catalogPrice;
}

/**
 * True only when BOTH a non-production NODE_ENV and an explicit
 * `DEV_FREE_SHIPPING_ENABLED=true` are present. A local-only switch so the whole
 * payable total for the token-priced system can be tested end to end (₹10 price
 * + ₹0 delivery = ₹10). Read at call time so a test can toggle it. Production can
 * never satisfy this, even with the flag set.
 */
export function freeShippingOverrideEnabled(
  nodeEnv: string | undefined = process.env.NODE_ENV,
  flag: string | undefined = process.env.DEV_FREE_SHIPPING_ENABLED,
): boolean {
  return nodeEnv !== 'production' && flag === 'true';
}

/**
 * Delivery fee for a subtotal: free once the subtotal EXCEEDS the threshold
 * (strictly greater), otherwise the flat fee. At exactly ₹10,000 the fee still
 * applies. While the local-only free-shipping override is active the fee is
 * always zero; production and normal configurations use the threshold rule.
 */
export function deliveryFeeForSubtotal(subtotal: number): number {
  if (freeShippingOverrideEnabled()) return 0;
  return subtotal > FREE_DELIVERY_THRESHOLD ? 0 : STANDARD_DELIVERY_FEE;
}

/** Total payable (subtotal + delivery), rounded to 2 dp. */
export function orderTotalForSubtotal(subtotal: number): number {
  return Math.round((subtotal + deliveryFeeForSubtotal(subtotal)) * 100) / 100;
}

/**
 * Estimated delivery date = the order's persisted timestamp plus the fixed
 * calendar-day window. Derived from the stored `createdAt` (never the browser's
 * clock), so the promise is stable once the order exists.
 */
export function estimatedDeliveryFrom(createdAt: Date | string): Date {
  const date = typeof createdAt === 'string' ? new Date(createdAt) : new Date(createdAt.getTime());
  date.setDate(date.getDate() + ESTIMATED_DELIVERY_DAYS);
  return date;
}
