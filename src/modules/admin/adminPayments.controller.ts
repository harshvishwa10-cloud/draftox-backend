import type { Request, Response } from 'express';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { ApiError } from '../../utils/ApiError.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { reconcileOrderPayment } from '../payments/reconciliation.js';
import { REFUND_SLA_HOURS, refundSlaCutoff } from '../payments/monitoring.js';
import { adminOrderDetailSelect, actorName } from './admin.controller.js';

const LIST_DEFAULT_LIMIT = 20;
const LIST_MAX_LIMIT = 100;

/** How long a pending online order may remain unresolved before reconciliation. */
const PENDING_PAYMENT_MINUTES = 15;

const exceptionListQuerySchema = z.object({
  status: z.enum(['OPEN', 'RESOLVED', 'ALL']).default('OPEN'),
  kind: z
    .enum([
      'UNMATCHED_PAYMENT',
      'AMOUNT_MISMATCH',
      'CURRENCY_MISMATCH',
      'CANCELLED_PAYMENT',
      'DUPLICATE_PAYMENT',
      'WEBHOOK_FAILED',
      'RECONCILE_FAILED',
    ])
    .optional(),
  limit: z.coerce.number().int().min(1).max(LIST_MAX_LIMIT).optional(),
  cursor: z.string().trim().min(1).max(100).optional(),
});

const resolveExceptionSchema = z
  .object({ note: z.string().trim().max(500).optional() })
  .strict();

const exceptionSelect = {
  id: true,
  kind: true,
  status: true,
  orderId: true,
  razorpayOrderId: true,
  razorpayPaymentId: true,
  amount: true,
  currency: true,
  reason: true,
  details: true,
  webhookEventId: true,
  createdAt: true,
  resolvedAt: true,
  resolvedBy: true,
  resolutionNote: true,
} as const;

/**
 * Lists payment exceptions for the admin queue (OPEN by default), newest first,
 * with an optional kind filter and cursor pagination, plus open/resolved counts.
 */
export const listPaymentExceptions = asyncHandler(async (req: Request, res: Response) => {
  const query = exceptionListQuerySchema.parse(req.query);
  const limit = Math.min(query.limit ?? LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT);

  const where: Prisma.PaymentExceptionWhereInput = {};
  if (query.status !== 'ALL') where.status = query.status;
  if (query.kind) where.kind = query.kind;

  const rows = await prisma.paymentException.findMany({
    where,
    select: exceptionSelect,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > limit;
  const exceptions = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore && exceptions.length > 0 ? exceptions[exceptions.length - 1].id : null;

  const [open, resolved] = await Promise.all([
    prisma.paymentException.count({ where: { status: 'OPEN' } }),
    prisma.paymentException.count({ where: { status: 'RESOLVED' } }),
  ]);

  res.status(200).json({
    success: true,
    data: { exceptions, nextCursor, counts: { open, resolved } },
  });
});

/**
 * Marks an exception RESOLVED, retaining who resolved it, when, and an optional
 * note. Idempotent: resolving an already-resolved row returns it unchanged.
 */
export const resolvePaymentException = asyncHandler(async (req: Request, res: Response) => {
  const id = String(req.params.id ?? '');
  const input = resolveExceptionSchema.parse(req.body ?? {});

  const existing = await prisma.paymentException.findUnique({
    where: { id },
    select: { id: true, status: true },
  });
  if (!existing) throw ApiError.notFound('Payment exception not found');

  if (existing.status === 'RESOLVED') {
    const current = await prisma.paymentException.findUnique({ where: { id }, select: exceptionSelect });
    res.status(200).json({ success: true, data: { exception: current, alreadyResolved: true } });
    return;
  }

  const updated = await prisma.paymentException.update({
    where: { id },
    data: {
      status: 'RESOLVED',
      resolvedAt: new Date(),
      resolvedBy: actorName(req) ?? req.user?.id ?? null,
      resolutionNote: input.note ?? null,
    },
    select: exceptionSelect,
  });
  res.status(200).json({ success: true, data: { exception: updated } });
});

/**
 * Operational visibility for the payment subsystem: open exceptions, recent
 * webhook failures, refunds past the 24h goal, and pending online orders old
 * enough that reconciliation should have settled them.
 */
export const getPaymentAuditSummary = asyncHandler(async (_req: Request, res: Response) => {
  const now = Date.now();
  const dayAgo = new Date(now - 24 * 60 * 60 * 1000);
  const refundSlaCutoff = new Date(now - REFUND_SLA_HOURS * 60 * 60 * 1000);
  const pendingCutoff = new Date(now - PENDING_PAYMENT_MINUTES * 60 * 1000);

  const [
    openExceptions,
    webhookFailed24h,
    webhookReceived24h,
    refundsAtRisk,
    pendingOnlineOrders,
    pendingUnmatched,
  ] = await Promise.all([
    prisma.paymentException.count({ where: { status: 'OPEN' } }),
    prisma.webhookEvent.count({ where: { status: 'FAILED', receivedAt: { gte: dayAgo } } }),
    prisma.webhookEvent.count({ where: { receivedAt: { gte: dayAgo } } }),
    prisma.refund.count({
      where: { status: { not: 'SUCCESS' }, createdAt: { lt: refundSlaCutoff } },
    }),
    prisma.order.count({
      where: {
        status: { in: ['REQUESTED', 'CONFIRMED'] },
        razorpayOrderId: { not: null },
        createdAt: { lt: pendingCutoff },
      },
    }),
    prisma.paymentException.count({
      where: { status: 'OPEN', kind: 'UNMATCHED_PAYMENT' },
    }),
  ]);

  res.status(200).json({
    success: true,
    data: {
      openExceptions,
      unmatchedPayments: pendingUnmatched,
      webhookFailures24h: webhookFailed24h,
      webhookReceived24h,
      refundsAtRisk,
      refundSlaHours: REFUND_SLA_HOURS,
      pendingOnlineOrders,
      pendingPaymentMinutes: PENDING_PAYMENT_MINUTES,
    },
  });
});

/**
 * Reconciles one order against the payment provider on demand — the manual
 * counterpart to the scheduled sweep. Marks the order PAID only on an exact
 * captured match; otherwise reports why nothing was applied.
 */
export const reconcileOrder = asyncHandler(async (req: Request, res: Response) => {
  const id = String(req.params.id ?? '');
  const result = await reconcileOrderPayment(id);

  const order =
    result.status === 'reconciled'
      ? await prisma.order.findUnique({ where: { id }, select: adminOrderDetailSelect })
      : undefined;

  res.status(200).json({
    success: true,
    data: {
      status: result.status,
      ...(result.paymentId ? { paymentId: result.paymentId } : {}),
      ...(result.reason ? { reason: result.reason } : {}),
      ...(order ? { order } : {}),
    },
  });
});

const refundListQuerySchema = z.object({
  status: z
    .enum(['ALL', 'REQUESTED', 'PROCESSING', 'SUCCESS', 'FAILED', 'MANUAL_REVIEW'])
    .default('ALL'),
  /** When 'true', only refunds past the SLA goal are returned. */
  atRisk: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(LIST_MAX_LIMIT).optional(),
  cursor: z.string().trim().min(1).max(100).optional(),
});

const refundRowSelect = {
  id: true,
  orderId: true,
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
  order: { select: { orderNumber: true, name: true, email: true, status: true } },
} as const;

/**
 * Lists refunds (optionally only those past the 24h goal) with their order's
 * customer-facing facts, newest first. Amounts and statuses are read-only
 * server truth; retrying a refund is a separate, guarded endpoint.
 */
export const listAdminRefunds = asyncHandler(async (req: Request, res: Response) => {
  const query = refundListQuerySchema.parse(req.query);
  const limit = Math.min(query.limit ?? LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT);
  const now = Date.now();
  const cutoff = refundSlaCutoff(now);

  const where: Prisma.RefundWhereInput = {};
  const onlyAtRisk = query.atRisk === 'true';
  if (onlyAtRisk) {
    where.status = { not: 'SUCCESS' };
    where.createdAt = { lt: cutoff };
  } else if (query.status !== 'ALL') {
    where.status = query.status;
  }

  const rows = await prisma.refund.findMany({
    where,
    select: refundRowSelect,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore && page.length > 0 ? page[page.length - 1].id : null;

  const refunds = page.map((row) => {
    const createdAt = row.createdAt.getTime();
    const hoursSinceCreated = Math.max(0, Math.round(((now - createdAt) / 3_600_000) * 10) / 10);
    const atRisk = row.status !== 'SUCCESS' && createdAt < cutoff.getTime();
    return { ...row, hoursSinceCreated, atRisk };
  });

  const [atRiskCount, pendingCount] = await Promise.all([
    prisma.refund.count({ where: { status: { not: 'SUCCESS' }, createdAt: { lt: cutoff } } }),
    prisma.refund.count({ where: { status: { not: 'SUCCESS' } } }),
  ]);

  res.status(200).json({
    success: true,
    data: {
      refunds,
      nextCursor,
      counts: { atRisk: atRiskCount, pending: pendingCount },
      refundSlaHours: REFUND_SLA_HOURS,
    },
  });
});
