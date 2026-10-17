import { Prisma, type PaymentExceptionKind } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { sendAlert } from '../../lib/alerts.js';

/** Exception kinds that indicate money that needs urgent attention. */
const CRITICAL_EXCEPTION_KINDS = new Set<PaymentExceptionKind>([
  'UNMATCHED_PAYMENT',
  'CANCELLED_PAYMENT',
  'WEBHOOK_FAILED',
]);

/** Fields captured when a payment needs a human look. Never includes secrets or raw payloads. */
export interface PaymentExceptionInput {
  kind: PaymentExceptionKind;
  orderId?: string | null;
  razorpayOrderId?: string | null;
  razorpayPaymentId?: string | null;
  amount?: Prisma.Decimal | number | null;
  currency?: string | null;
  reason: string;
  details?: Prisma.InputJsonValue;
  /**
   * The source webhook event, when the exception came from one. Its unique
   * column makes webhook-sourced exceptions idempotent across retries.
   */
  webhookEventId?: string | null;
}

/**
 * Records a payment exception for the admin queue. Best-effort and never throws:
 * an exception on the money path must not turn into a 500 that hides the real
 * outcome. Webhook-sourced rows dedupe on `webhookEventId` (unique); other rows
 * (e.g. reconciliation) dedupe on kind + provider ids while still OPEN.
 */
export async function recordPaymentException(input: PaymentExceptionInput): Promise<void> {
  try {
    if (!input.webhookEventId) {
      const existing = await prisma.paymentException.findFirst({
        where: {
          kind: input.kind,
          status: 'OPEN',
          razorpayOrderId: input.razorpayOrderId ?? null,
          razorpayPaymentId: input.razorpayPaymentId ?? null,
        },
        select: { id: true },
      });
      if (existing) return;
    }
    await prisma.paymentException.create({
      data: {
        kind: input.kind,
        orderId: input.orderId ?? null,
        razorpayOrderId: input.razorpayOrderId ?? null,
        razorpayPaymentId: input.razorpayPaymentId ?? null,
        amount: input.amount ?? null,
        currency: input.currency ?? null,
        reason: input.reason,
        details: input.details,
        webhookEventId: input.webhookEventId ?? null,
      },
    });
    // A new exception needs a human look — raise one deduplicated operational
    // alert per kind. Fire-and-forget: alerting must never block the money path.
    void sendAlert({
      key: `payment_exception:${input.kind}`,
      severity: CRITICAL_EXCEPTION_KINDS.has(input.kind) ? 'critical' : 'warning',
      title: `Payment exception: ${input.kind}`,
      message: input.reason,
      metadata: {
        kind: input.kind,
        orderId: input.orderId ?? undefined,
        razorpayOrderId: input.razorpayOrderId ?? undefined,
        razorpayPaymentId: input.razorpayPaymentId ?? undefined,
        amount: input.amount != null ? String(input.amount) : undefined,
        currency: input.currency ?? undefined,
      },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      // Already queued for this webhook event — idempotent no-op.
      return;
    }
    logger.error('payment_exception_record_failed', {
      kind: input.kind,
      razorpayOrderId: input.razorpayOrderId ?? undefined,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
