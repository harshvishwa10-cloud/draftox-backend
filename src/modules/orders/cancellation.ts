/**
 * Pure customer-cancellation rules. Deliberately separate from the controller
 * so the eligibility matrix can be unit tested without a database.
 *
 * An order is cancellable by its owner UNLESS:
 *   - it is already cancelled (status or fulfilment CANCELLED) — reported back
 *     by the controller as an idempotent success, not an error;
 *   - it is DELIVERED — the customer is pointed at the return process instead;
 *   - it is SHIPPED or OUT_FOR_DELIVERY — the package is with the courier, and
 *     we never claim to be able to stop a parcel we do not control.
 *
 * REQUESTED/CONFIRMED/PAID/FAILED orders at AWAITING_PAYMENT, PROCESSING or
 * READY_TO_SHIP are cancellable. A PAID cancellation additionally produces a
 * refund obligation (handled in the controller via the refund module).
 */
import type { OrderStatus, FulfillmentStatus } from '@prisma/client';

export type CancellationBlockReason = 'DELIVERED' | 'WITH_COURIER';

export type CancellationEligibility =
  | { allowed: true; reason: null }
  | { allowed: false; reason: 'ALREADY_CANCELLED' }
  | { allowed: false; reason: CancellationBlockReason };

export interface CancellationCheckInput {
  status: string | OrderStatus;
  fulfillmentStatus: string | FulfillmentStatus;
}

export function canCustomerCancel(order: CancellationCheckInput): CancellationEligibility {
  if (order.status === 'CANCELLED' || order.fulfillmentStatus === 'CANCELLED') {
    return { allowed: false, reason: 'ALREADY_CANCELLED' };
  }
  switch (order.fulfillmentStatus) {
    case 'DELIVERED':
      return { allowed: false, reason: 'DELIVERED' };
    case 'SHIPPED':
    case 'OUT_FOR_DELIVERY':
      return { allowed: false, reason: 'WITH_COURIER' };
    default:
      return { allowed: true, reason: null };
  }
}

/** Human-readable, truthful explanations surfaced to the customer/UI. */
export const CANCELLATION_MESSAGES: Record<CancellationBlockReason, string> = {
  DELIVERED:
    'This order has already been delivered, so it cannot be cancelled. If something is wrong, please start a return request from your order within the return window, or contact us on WhatsApp.',
  WITH_COURIER:
    'This order is already with the courier and cannot be cancelled online. Once it is delivered you can start a return request, or contact us on WhatsApp and we will help you.',
};

export const CANCELLATION_CONFIRM_MESSAGE =
  'We will not charge you for a cancelled unpaid order. If you already paid, a refund will be initiated and the money will be returned as soon as the payment provider processes it.';