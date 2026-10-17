import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';

/**
 * Result of attempting to transition an order to PAID.
 *
 * - `paid`             — the order transitioned (or a concurrent retry already had).
 * - `not_payable`      — the order exists but is not in a payable status (e.g. it
 *                        was already PAID, or is CANCELLED). Payment status is left
 *                        untouched; the caller decides whether this is a duplicate.
 * - `duplicate_payment`— the Razorpay payment id is already recorded on a DIFFERENT
 *                        order (unique index). Never re-associated.
 */
export type MarkPaidOutcome = 'paid' | 'not_payable' | 'duplicate_payment';

/**
 * Transitions an order to PAID exactly once, recording the verified payment id
 * and an audit event. Payment and fulfilment statuses stay separate: the only
 * fulfilment effect is to move a still-AWAITING_PAYMENT order to PROCESSING,
 * since a paid order has by definition moved past awaiting payment.
 *
 * Idempotency: the guarded `updateMany` (status ∈ REQUESTED/CONFIRMED/FAILED)
 * means a replayed payment for an already-PAID order changes nothing. A payment
 * id already used on another order is rejected by the unique index (P2002) and
 * reported as `duplicate_payment` — it is never re-associated.
 */
export async function markOrderPaid(
  orderId: string,
  paymentId?: string,
  paymentMethod?: string,
): Promise<MarkPaidOutcome> {
  try {
    return await prisma.$transaction(async (tx) => {
      const updated = await tx.order.updateMany({
        where: { id: orderId, status: { in: ['REQUESTED', 'CONFIRMED', 'FAILED'] } },
        data: {
          status: 'PAID',
          ...(paymentId ? { razorpayPaymentId: paymentId } : {}),
          ...(paymentMethod ? { paymentMethod } : {}),
        },
      });
      if (updated.count === 0) return 'not_payable';

      await tx.orderEvent.create({
        data: {
          orderId,
          type: 'PAYMENT_VERIFIED',
          message: paymentMethod ? `Payment verified via ${paymentMethod}` : 'Payment verified',
          metadata: {
            ...(paymentId ? { razorpayPaymentId: paymentId } : {}),
            ...(paymentMethod ? { paymentMethod } : {}),
          },
        },
      });

      const advanced = await tx.order.updateMany({
        where: { id: orderId, fulfillmentStatus: 'AWAITING_PAYMENT' },
        data: { fulfillmentStatus: 'PROCESSING' },
      });
      if (advanced.count > 0) {
        await tx.orderEvent.create({
          data: {
            orderId,
            type: 'FULFILLMENT_CHANGED',
            message: 'Fulfilment: AWAITING_PAYMENT → PROCESSING',
            metadata: { from: 'AWAITING_PAYMENT', to: 'PROCESSING', automatic: true },
          },
        });
      }
      return 'paid';
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      // This Razorpay payment id is already recorded on a different order —
      // never re-associate it; leave the status untouched.
      return 'duplicate_payment';
    }
    throw err;
  }
}
