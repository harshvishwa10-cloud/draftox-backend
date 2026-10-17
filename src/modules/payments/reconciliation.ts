import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { razorpayConfigured } from '../../config/env.js';
import { razorpayAuthHeader, toPaise } from './razorpay.js';
import { markOrderPaid } from './orderPayment.js';
import { recordPaymentException } from './exceptions.js';

const RAZORPAY_API = 'https://api.razorpay.com/v1';
const PROVIDER_TIMEOUT_MS = 10_000;

interface ProviderPayment {
  id?: string;
  order_id?: string;
  amount?: number;
  currency?: string;
  status?: string;
  method?: string;
}

export type ReconcileStatus =
  | 'reconciled'
  | 'already_paid'
  | 'pending'
  | 'not_found'
  | 'no_provider_order'
  | 'not_configured'
  | 'mismatch'
  | 'error';

export interface ReconcileResult {
  status: ReconcileStatus;
  paymentId?: string;
  reason?: string;
}

/** Server-to-server lookup of the payments Razorpay holds against an order. */
async function fetchRazorpayOrderPayments(
  razorpayOrderId: string,
): Promise<{ ok: boolean; items: ProviderPayment[] }> {
  try {
    const response = await fetch(
      `${RAZORPAY_API}/orders/${encodeURIComponent(razorpayOrderId)}/payments`,
      {
        headers: { Authorization: razorpayAuthHeader() },
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      },
    );
    if (!response.ok) return { ok: false, items: [] };
    const body = (await response.json()) as { items?: ProviderPayment[] };
    return { ok: true, items: Array.isArray(body.items) ? body.items : [] };
  } catch {
    return { ok: false, items: [] };
  }
}

/**
 * Picks the payment that should reconcile an order: a captured payment linked to
 * the same Razorpay order, for the exact expected amount and currency. Pure and
 * unit-testable. Returns null when nothing qualifies.
 */
export function matchCapturedPayment(
  items: ProviderPayment[],
  razorpayOrderId: string,
  expectedPaise: number,
  currency: string,
): ProviderPayment | null {
  for (const item of items) {
    if (!item.id) continue;
    if (item.status !== 'captured') continue;
    if (item.order_id && item.order_id !== razorpayOrderId) continue;
    if (typeof item.amount === 'number' && item.amount !== expectedPaise) continue;
    if (item.currency && item.currency !== currency) continue;
    return item;
  }
  return null;
}

/**
 * Reconciles a single order against Razorpay. This is the safety net for a
 * missed or failed webhook (and for a payment that arrived before the order row
 * was visible): it asks the provider which payments exist for the order and
 * marks the order PAID only on an exact captured match.
 *
 * It NEVER invents a payment and NEVER marks a CANCELLED order PAID — a captured
 * payment on a cancelled order becomes an exception for manual refund instead.
 */
export async function reconcileOrderPayment(orderId: string): Promise<ReconcileResult> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      status: true,
      amount: true,
      currency: true,
      razorpayOrderId: true,
      razorpayPaymentId: true,
    },
  });
  if (!order) return { status: 'not_found' };
  if (order.status === 'PAID') return { status: 'already_paid' };
  if (!order.razorpayOrderId) return { status: 'no_provider_order' };
  if (!razorpayConfigured) return { status: 'not_configured' };

  const expectedPaise = toPaise(order.amount.toString());
  if (!Number.isFinite(expectedPaise)) return { status: 'error', reason: 'invalid_local_amount' };

  const { ok, items } = await fetchRazorpayOrderPayments(order.razorpayOrderId);
  if (!ok) {
    logger.warn('payment_reconcile_provider_unreachable', {
      orderId: order.id,
      razorpayOrderId: order.razorpayOrderId,
    });
    return { status: 'error', reason: 'provider_unreachable' };
  }

  const match = matchCapturedPayment(items, order.razorpayOrderId, expectedPaise, order.currency);
  if (!match || !match.id) {
    const hasPending = items.some((i) =>
      ['authorized', 'created', 'pending'].includes(String(i.status)),
    );
    return { status: hasPending ? 'pending' : 'not_found' };
  }

  if (order.status === 'CANCELLED') {
    await recordPaymentException({
      kind: 'CANCELLED_PAYMENT',
      orderId: order.id,
      razorpayOrderId: order.razorpayOrderId,
      razorpayPaymentId: match.id,
      amount: order.amount,
      currency: order.currency,
      reason:
        'A captured payment was found for an order that is already cancelled. A manual refund is required.',
      details: { source: 'reconcile' },
    });
    return { status: 'mismatch', reason: 'cancelled', paymentId: match.id };
  }

  const outcome = await markOrderPaid(order.id, match.id, match.method);
  if (outcome === 'duplicate_payment') {
    await recordPaymentException({
      kind: 'DUPLICATE_PAYMENT',
      orderId: order.id,
      razorpayOrderId: order.razorpayOrderId,
      razorpayPaymentId: match.id,
      amount: order.amount,
      currency: order.currency,
      reason: 'This payment id is already recorded on a different order.',
      details: { source: 'reconcile' },
    });
    return { status: 'mismatch', reason: 'duplicate_payment', paymentId: match.id };
  }

  logger.info('payment_reconciled', {
    orderId: order.id,
    razorpayOrderId: order.razorpayOrderId,
    razorpayPaymentId: match.id,
  });
  return { status: 'reconciled', paymentId: match.id };
}

export interface ReconcileBatchSummary {
  scanned: number;
  reconciled: number;
  alreadyPaid: number;
  pending: number;
  notFound: number;
  failed: number;
}

/**
 * Reconciliation sweep over orders that are still pending payment but have a
 * Razorpay order old enough to have settled. Bounded and sequential so it can be
 * run from a scheduled job without stampeding the provider. Database-driven (no
 * in-memory queue), so it is safe to run on a cron / one-off worker.
 */
export async function reconcilePendingPayments(options?: {
  olderThanMinutes?: number;
  limit?: number;
}): Promise<ReconcileBatchSummary> {
  const olderThanMinutes = options?.olderThanMinutes ?? 10;
  const limit = options?.limit ?? 25;
  const cutoff = new Date(Date.now() - olderThanMinutes * 60_000);

  const orders = await prisma.order.findMany({
    where: {
      status: { in: ['REQUESTED', 'CONFIRMED'] },
      razorpayOrderId: { not: null },
      createdAt: { lt: cutoff },
    },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
    take: limit,
  });

  const summary: ReconcileBatchSummary = {
    scanned: orders.length,
    reconciled: 0,
    alreadyPaid: 0,
    pending: 0,
    notFound: 0,
    failed: 0,
  };

  for (const { id } of orders) {
    try {
      const result = await reconcileOrderPayment(id);
      switch (result.status) {
        case 'reconciled':
          summary.reconciled += 1;
          break;
        case 'already_paid':
          summary.alreadyPaid += 1;
          break;
        case 'pending':
          summary.pending += 1;
          break;
        case 'not_found':
        case 'no_provider_order':
        case 'not_configured':
        case 'mismatch':
          summary.notFound += 1;
          break;
        case 'error':
          summary.failed += 1;
          break;
      }
    } catch (err) {
      summary.failed += 1;
      logger.error('payment_reconcile_failed', {
        orderId: id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return summary;
}
