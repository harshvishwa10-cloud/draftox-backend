/**
 * Order fulfilment state machine.
 *
 * Fulfilment status is intentionally separate from payment/order status: an
 * order only advances past AWAITING_PAYMENT once its payment is verified, and
 * transitions are forward-only so a delivery can never be "confirmed" without
 * passing through the real stages.
 */
import type { FulfillmentStatus } from '@prisma/client';

export const FULFILLMENT_STATUSES: readonly FulfillmentStatus[] = [
  'AWAITING_PAYMENT',
  'PROCESSING',
  'READY_TO_SHIP',
  'SHIPPED',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'CANCELLED',
] as const;

/** Allowed forward transitions. Terminal states map to an empty list. */
export const FULFILLMENT_TRANSITIONS: Record<FulfillmentStatus, readonly FulfillmentStatus[]> = {
  AWAITING_PAYMENT: ['PROCESSING', 'CANCELLED'],
  PROCESSING: ['READY_TO_SHIP', 'CANCELLED'],
  READY_TO_SHIP: ['SHIPPED', 'CANCELLED'],
  SHIPPED: ['OUT_FOR_DELIVERY', 'DELIVERED'],
  OUT_FOR_DELIVERY: ['DELIVERED'],
  DELIVERED: [],
  CANCELLED: [],
};

export const FULFILLMENT_LABELS: Record<FulfillmentStatus, string> = {
  AWAITING_PAYMENT: 'Awaiting payment',
  PROCESSING: 'Processing',
  READY_TO_SHIP: 'Ready to ship',
  SHIPPED: 'Shipped',
  OUT_FOR_DELIVERY: 'Out for delivery',
  DELIVERED: 'Delivered',
  CANCELLED: 'Cancelled',
};

export function isFulfillmentStatus(value: unknown): value is FulfillmentStatus {
  return typeof value === 'string' && (FULFILLMENT_STATUSES as readonly string[]).includes(value);
}

export function canTransitionFulfillment(
  from: FulfillmentStatus,
  to: FulfillmentStatus,
): boolean {
  return FULFILLMENT_TRANSITIONS[from].includes(to);
}

export function allowedFulfillmentTransitions(
  from: FulfillmentStatus,
): readonly FulfillmentStatus[] {
  return FULFILLMENT_TRANSITIONS[from];
}

/**
 * Statuses that may only be entered after payment is verified. Cancelling and
 * staying at AWAITING_PAYMENT do not require payment.
 */
export function fulfillmentRequiresPaid(to: FulfillmentStatus): boolean {
  return to !== 'AWAITING_PAYMENT' && to !== 'CANCELLED';
}
