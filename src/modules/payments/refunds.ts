import { randomBytes } from 'node:crypto';
import type { Prisma, RefundStatus } from '@prisma/client';
import { razorpayConfigured } from '../../config/env.js';
import { prisma } from '../../lib/prisma.js';
import { ApiError } from '../../utils/ApiError.js';
import { razorpayAuthHeader, toPaise } from './razorpay.js';

/**
 * Refund lifecycle for paid, verified orders that are cancelled or returned.
 *
 * A Refund row is created REQUESTED inside the SAME transaction as the
 * cancellation/return decision (see createRefundInTransaction), so a crash can
 * never lose the obligation to refund the customer. Provider work happens after
 * commit: the row is claimed REQUESTED/FAILED/MANUAL_REVIEW → PROCESSING by an
 * atomic guarded update before any network call, so concurrent retries can
 * never double-post a refund. SUCCESS is only recorded when the provider
 * reports the refund as processed — never as an aspiration.
 *
 * A paid order is the ONLY one that ever gets a refund row, the amount is
 * always the full server-side order amount (never client-supplied), and only a
 * razorpayPaymentId recorded by a verified payment flow can be used.
 */

export const REFUND_STATUSES: readonly RefundStatus[] = [
  'REQUESTED',
  'PROCESSING',
  'SUCCESS',
  'FAILED',
  'MANUAL_REVIEW',
] as const;

/** Statuses a refund attempt/retry may safely claim before provider work. */
export const REFUND_RECOVERABLE: readonly RefundStatus[] = [
  'REQUESTED',
  'FAILED',
  'MANUAL_REVIEW',
] as const;

export function isRefundStatus(value: unknown): value is RefundStatus {
  return typeof value === 'string' && (REFUND_STATUSES as readonly string[]).includes(value);
}

export function canAttemptRefundFrom(status: RefundStatus): boolean {
  return (REFUND_RECOVERABLE as readonly RefundStatus[]).includes(status);
}

export const REFUND_LABELS: Record<RefundStatus, string> = {
  REQUESTED: 'Refund requested',
  PROCESSING: 'Refund processing',
  SUCCESS: 'Refund completed',
  FAILED: 'Refund failed',
  MANUAL_REVIEW: 'Refund needs manual review',
};

export type RefundSource = 'CANCEL' | 'ADMIN' | 'RETURN';

/** Safe serialization shared by customer- and admin-facing order details. */
export const refundSelect = {
  id: true,
  amount: true,
  currency: true,
  status: true,
  provider: true,
  providerRefundId: true,
  error: true,
  initiatedBy: true,
  initiatedAt: true,
  completedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

function newIdempotencyKey(): string {
  return `ref:${randomBytes(16).toString('base64url')}`;
}

/**
 * Creates the obligation to refund exactly once per order, inside the caller's
 * open transaction. A second call for the same order simply returns the
 * existing row (created: false) without re-creating it or duplicating the
 * REFUND_INITIATED event.
 *
 * Reads-then-writes (no P2002 catch): Prisma interactive transactions are
 * aborted by PostgreSQL on the first failed statement, so a violation caught
 * here could never be inspected on the same connection. The read-then-write
 * makes sequential double-taps safe; the unique orderId constraint still backs
 * the write, and a truly concurrent duplicate simply aborts that transaction
 * (the loser's request errors, the winner's refund is never duplicated).
 */
export async function createRefundInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    orderId: string;
    amount: Prisma.Decimal | number;
    currency: string;
    source: RefundSource;
    actorId?: string | null;
    actorName?: string | null;
  },
): Promise<{ refund: { id: string; status: RefundStatus }; created: boolean }> {
  const existing = await tx.refund.findUnique({
    where: { orderId: input.orderId },
    select: { id: true, status: true, provider: true, error: true },
  });
  if (existing) {
    return { refund: existing, created: false };
  }

  const refund = await tx.refund.create({
    data: {
      orderId: input.orderId,
      amount: input.amount,
      currency: input.currency,
      status: 'REQUESTED',
      provider: razorpayConfigured ? 'razorpay' : null,
      idempotencyKey: newIdempotencyKey(),
      initiatedBy: input.source,
      initiatedById: input.actorId ?? null,
      initiatedAt: new Date(),
    },
    select: { id: true, status: true },
  });
  await tx.orderEvent.create({
    data: {
      orderId: input.orderId,
      type: 'REFUND_INITIATED',
      message: `Refund requested (${input.source})`,
      actorId: input.actorId ?? null,
      actorName: input.actorName ?? null,
      metadata: { refundId: refund.id, initiatedBy: input.source },
    },
  });
  return { refund, created: true };
}

/**
 * Result of attempting the provider refund; the persistence layer decides the
 * API-facing RefundStatus from these provider facts.
 */
export interface ProviderRefundAttempt {
  outcome: 'success' | 'pending' | 'failed';
  providerRefundId: string | null;
  error: string | null;
}

/**
 * Pure parser for the Razorpay refund entity. `processed` is the provider's own
 * confirmation that the money moved; `pending`/`created` mean it is accepted but
 * not yet processed. Anything else is a failure. Kept pure and unit-tested.
 */
export function parseRefundResponse(data: unknown): ProviderRefundAttempt {
  if (!data || typeof data !== 'object') {
    return { outcome: 'failed', providerRefundId: null, error: 'Payment provider returned an invalid response.' };
  }
  const entity = data as { id?: unknown; status?: unknown; error?: { reason?: unknown } };
  const providerRefundId = typeof entity.id === 'string' && entity.id.length > 0 ? entity.id : null;
  const status = typeof entity.status === 'string' ? entity.status : '';
  switch (status) {
    case 'processed':
      return { outcome: 'success', providerRefundId, error: null };
    case 'pending':
    case 'created':
      return { outcome: 'pending', providerRefundId, error: null };
    default: {
      const reason =
        entity.error && typeof entity.error === 'object' && entity.error.reason
          ? String(entity.error.reason).slice(0, 300)
          : 'Payment provider rejected the refund request.';
      return { outcome: 'failed', providerRefundId, error: reason };
    }
  }
}

/**
 * Posts a refund to Razorpay for a verified payment. Idempotent on the provider
 * side (refunds are keyed to the payment); our own idempotency is enforced by
 * the Refund row before this is ever reached. Never throws network errors.
 */
export async function requestProviderRefund(
  paymentId: string,
  amountPaise: number,
  notes: Record<string, string>,
): Promise<ProviderRefundAttempt> {
  if (!Number.isFinite(amountPaise) || amountPaise <= 0) {
    return { outcome: 'failed', providerRefundId: null, error: 'Refund amount is invalid.' };
  }
  try {
    const response = await fetch(
      `https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}/refund`,
      {
        method: 'POST',
        headers: {
          Authorization: razorpayAuthHeader(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ amount: amountPaise, notes }),
      },
    );
    if (!response.ok) {
      // Surface the provider's own reason when it gives one — it goes straight
      // to the admin's troubleshooting view.
      let reason: string | null = null;
      try {
        const body = (await response.json()) as { error?: { reason?: unknown } };
        if (body?.error && typeof body.error === 'object' && body.error.reason) {
          reason = String(body.error.reason).slice(0, 300);
        }
      } catch {
        // Body may be empty/non-JSON on some failures.
      }
      return {
        outcome: 'failed',
        providerRefundId: null,
        error: reason ?? 'Payment provider rejected the refund request.',
      };
    }
    return parseRefundResponse(await response.json());
  } catch {
    return {
      outcome: 'failed',
      providerRefundId: null,
      error: 'Could not reach the payment provider. The refund stays pending and can be retried.',
    };
  }
}

export interface RefundOutcome {
  refundId: string;
  status: RefundStatus;
  provider: string | null;
  /** True when the row was already acted on and this call changed nothing. */
  alreadyProcessed: boolean;
  error: string | null;
}

async function recordRefundEvent(
  orderId: string,
  type: 'REFUND_UPDATED' | 'REFUND_COMPLETED' | 'REFUND_FAILED',
  metadata: Prisma.InputJsonValue,
): Promise<void> {
  await prisma.orderEvent.create({
    data: {
      orderId,
      type,
      message:
        type === 'REFUND_COMPLETED'
          ? 'Refund completed by the payment provider'
          : type === 'REFUND_FAILED'
            ? 'Refund attempt failed'
            : 'Refund status updated',
      metadata,
    },
  });
}

/**
 * Tries to execute a pending refund (provider call + truthful state update).
 *
 * Guarded update: summary of the flow.
 *   REQUESTED/FAILED/MANUAL_REVIEW → claimed → PROCESSING
 *     - no verified payment id          → MANUAL_REVIEW (never invent a refund)
 *     - provider not configured         → MANUAL_REVIEW (truthful)
 *     - provider reports processed      → SUCCESS (+ providerRefundId, completedAt)
 *     - provider reports pending        → PROCESSING stays (accepted, not done)
 *     - provider rejects/errors         → FAILED (retryable)
 *   SUCCESS / PROCESSING rows are never double-processed.
 */
export async function processRefund(refundId: string): Promise<RefundOutcome> {
  const refund = await prisma.refund.findUnique({
    where: { id: refundId },
    select: { id: true, status: true, provider: true, orderId: true, amount: true },
  });
  if (!refund) throw ApiError.notFound('Refund not found');

  if (refund.status === 'SUCCESS') {
    return {
      refundId,
      status: 'SUCCESS',
      provider: refund.provider,
      alreadyProcessed: true,
      error: null,
    };
  }
  if (refund.status === 'PROCESSING') {
    return {
      refundId,
      status: 'PROCESSING',
      provider: refund.provider,
      alreadyProcessed: true,
      error: 'This refund is already being processed and awaits the provider confirmation.',
    };
  }

  const claimed = await prisma.refund.updateMany({
    where: { id: refundId, status: { in: [...REFUND_RECOVERABLE] } },
    data: { status: 'PROCESSING', error: null, provider: razorpayConfigured ? 'razorpay' : null },
  });
  if (claimed.count === 0) {
    // A concurrent retry got there first and changed the state.
    const latest = await prisma.refund.findUnique({
      where: { id: refundId },
      select: { status: true, provider: true, error: true },
    });
    return {
      refundId,
      status: latest?.status ?? refund.status,
      provider: latest?.provider ?? null,
      alreadyProcessed: true,
      error: latest?.error ?? null,
    };
  }

  await recordRefundEvent(refund.orderId, 'REFUND_UPDATED', {
    refundId,
    stage: 'processing',
    provider: razorpayConfigured ? 'razorpay' : null,
  });

  const order = await prisma.order.findUnique({
    where: { id: refund.orderId },
    select: {
      id: true,
      orderNumber: true,
      razorpayPaymentId: true,
      amount: true,
      currency: true,
    },
  });

  const paymentId = order?.razorpayPaymentId ?? null;
  const manualReason = !paymentId
    ? 'No verified payment id is stored for this order — a team member must complete this refund manually.'
    : !razorpayConfigured
      ? 'The refund provider is not configured on this server — a team member must complete this refund manually.'
      : null;

  if (manualReason) {
    await prisma.refund.update({
      where: { id: refundId },
      data: { status: 'MANUAL_REVIEW', error: manualReason },
    });
    await recordRefundEvent(refund.orderId, 'REFUND_FAILED', {
      refundId,
      reason: paymentId ? 'provider_not_configured' : 'missing_payment_id',
    });
    return {
      refundId,
      status: 'MANUAL_REVIEW',
      provider: null,
      alreadyProcessed: false,
      error: manualReason,
    };
  }

  const amountPaise = toPaise(refund.amount.toString());
  const attempt = await requestProviderRefund(paymentId as string, amountPaise, {
    store_order_id: refund.orderId,
    store_order_number: order?.orderNumber ?? 'n/a',
    store_refund_id: refundId,
  });

  if (attempt.outcome === 'success') {
    await prisma.refund.update({
      where: { id: refundId },
      data: {
        status: 'SUCCESS',
        provider: 'razorpay',
        providerRefundId: attempt.providerRefundId,
        error: null,
        completedAt: new Date(),
      },
    });
    await recordRefundEvent(refund.orderId, 'REFUND_COMPLETED', {
      refundId,
      providerRefundId: attempt.providerRefundId,
      amountPaise,
    });
    return {
      refundId,
      status: 'SUCCESS',
      provider: 'razorpay',
      alreadyProcessed: false,
      error: null,
    };
  }

  if (attempt.outcome === 'pending') {
    await prisma.refund.update({
      where: { id: refundId },
      data: {
        status: 'PROCESSING',
        provider: 'razorpay',
        providerRefundId: attempt.providerRefundId,
        error: null,
      },
    });
    await recordRefundEvent(refund.orderId, 'REFUND_UPDATED', {
      refundId,
      stage: 'pending_at_provider',
      providerRefundId: attempt.providerRefundId,
    });
    return {
      refundId,
      status: 'PROCESSING',
      provider: 'razorpay',
      alreadyProcessed: false,
      error: null,
    };
  }

  await prisma.refund.update({
    where: { id: refundId },
    data: { status: 'FAILED', error: attempt.error, provider: 'razorpay' },
  });
  await recordRefundEvent(refund.orderId, 'REFUND_FAILED', {
    refundId,
    error: attempt.error,
  });
  return {
    refundId,
    status: 'FAILED',
    provider: 'razorpay',
    alreadyProcessed: false,
    error: attempt.error,
  };
}