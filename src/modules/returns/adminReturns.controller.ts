import type { Request, Response } from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Prisma, ReturnStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { ApiError } from '../../utils/ApiError.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { adminReturnListQuerySchema, decideReturnSchema } from '../../schemas/return.schema.js';
import {
  isValidPhotoId,
  photoFilePath,
  uploadsDirectory,
} from './photos.js';
import {
  actionTargetFor,
  isTerminalReturnStatus,
  RETURN_STATUSES,
  RETURN_STATUS_LABELS,
} from './state.js';
import { createRefundInTransaction, processRefund } from '../payments/refunds.js';
import { escapeHtml } from '../shipping/notifications.js';
import {
  buildReturnDecisionEmail,
  sendOrderEmail,
  toOrderContext,
} from '../orders/orderEmails.js';

const adminReturnSelect = {
  id: true,
  orderId: true,
  userId: true,
  reason: true,
  explanation: true,
  status: true,
  needsReview: true,
  photos: true,
  decisionNote: true,
  decidedBy: true,
  decidedById: true,
  decidedAt: true,
  closedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

const adminReturnOrderSelect = {
  id: true,
  orderNumber: true,
  name: true,
  email: true,
  status: true,
  fulfillmentStatus: true,
  paymentMethod: true,
  amount: true,
  currency: true,
} as const;

const LIST_DEFAULT_LIMIT = 30;
const LIST_MAX_LIMIT = 100;

/** Admin list of return requests, newest first, optional status filter/search. */
export const listAdminReturns = asyncHandler(async (req: Request, res: Response) => {
  const query = adminReturnListQuerySchema.parse(req.query);
  const where: Prisma.ReturnRequestWhereInput = {};
  if (query.status) {
    if (!(RETURN_STATUSES as readonly string[]).includes(query.status)) {
      throw ApiError.badRequest('Unknown return status');
    }
    where.status = query.status as ReturnStatus;
  }
  if (query.q) {
    const q = query.q.trim();
    const isNumber = /^\d{1,6}$/.test(q);
    const orderMatchers: Prisma.OrderWhereInput[] = [
      { name: { contains: q, mode: 'insensitive' } },
      { email: { contains: q, mode: 'insensitive' } },
    ];
    if (isNumber) orderMatchers.push({ orderNumber: { contains: q } });
    where.order = { OR: orderMatchers };
  }

  const rawLimit = Number(req.query.limit);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(Math.trunc(rawLimit), 1), LIST_MAX_LIMIT)
    : LIST_DEFAULT_LIMIT;

  const rows = await prisma.returnRequest.findMany({
    where,
    select: { ...adminReturnSelect, order: { select: adminReturnOrderSelect } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
  });
  const hasMore = rows.length > limit;
  const returnRequests = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor =
    hasMore && returnRequests.length > 0 ? returnRequests[returnRequests.length - 1].id : null;
  res.status(200).json({ success: true, data: { returnRequests, nextCursor } });
});

/** Admin detail for a single return request (including customer + items). */
export const getAdminReturn = asyncHandler(async (req: Request, res: Response) => {
  const id = String(req.params.id ?? '');
  const returnRequest = await prisma.returnRequest.findUnique({
    where: { id },
    select: {
      ...adminReturnSelect,
      order: {
        select: {
          ...adminReturnOrderSelect,
          items: true,
          shipment: { select: { deliveredAt: true } },
        },
      },
    },
  });
  if (!returnRequest) throw ApiError.notFound('Return request not found');
  res.status(200).json({ success: true, data: { returnRequest } });
});

/**
 * Serves one stored return photo to an admin. Files are never under any static
 * mount, and the photo id must be a whitelisted token that exists in the stored
 * metadata, so URL input can never walk directories.
 */
export const getAdminReturnPhoto = asyncHandler(async (req: Request, res: Response) => {
  const id = String(req.params.id ?? '');
  const photoId = String(req.params.photoId ?? '');
  if (!isValidPhotoId(photoId)) throw ApiError.notFound('Photo not found');
  const returnRequest = await prisma.returnRequest.findUnique({
    where: { id },
    select: { photos: true },
  });
  if (!returnRequest) throw ApiError.notFound('Return request not found');
  const photos = (returnRequest.photos as { id: string; storedName: string; mime: string }[]) ?? [];
  const photo = photos.find((p) => p && p.id === photoId && typeof p.storedName === 'string');
  if (!photo) throw ApiError.notFound('Photo not found');

  const root = path.resolve(uploadsDirectory());
  const target = path.resolve(photoFilePath(photo.storedName));
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw ApiError.notFound('Photo not found');
  }
  if (!existsSync(target)) throw ApiError.notFound('Photo not found');

  res.setHeader('Content-Type', photo.mime);
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.sendFile(target);
});

type ReturnDecisionAction = 'APPROVE' | 'REJECT' | 'RECEIVED' | 'RESOLVE';

const DECISION_EMAIL_COPY: Record<
  ReturnDecisionAction,
  { heading: string; bodyHtml: string; bodyText: string }
> = {
  APPROVE: {
    heading: 'Return request approved',
    bodyHtml:
      '<p style="margin:0 0 12px;">Your return request was approved. Please pack the item securely with all accessories and ship it to the address our team confirms on WhatsApp.</p><p style="margin:0 0 12px;">We will confirm the refund (if applicable) once the item is received.</p>',
    bodyText:
      'Your return request was approved. Please pack the item securely with all accessories and ship it to the address our team confirms on WhatsApp. We will confirm the refund (if applicable) once the item is received.',
  },
  REJECT: {
    heading: 'Return request update',
    bodyHtml:
      '<p style="margin:0 0 12px;">Your return request was reviewed and could not be approved. Our team has left a note below.</p>',
    bodyText:
      'Your return request was reviewed and could not be approved. Our team has left a note below.',
  },
  RECEIVED: {
    heading: 'Item received',
    bodyHtml:
      '<p style="margin:0 0 12px;">We received the returned item. Our team is inspecting it and will confirm the refund (if applicable) shortly.</p>',
    bodyText:
      'We received the returned item. Our team is inspecting it and will confirm the refund (if applicable) shortly.',
  },
  RESOLVE: {
    heading: 'Return request resolved',
    bodyHtml:
      '<p style="margin:0 0 12px;">Your return has been resolved. If a refund applies, it is being processed back to your original payment method.</p>',
    bodyText:
      'Your return has been resolved. If a refund applies, it is being processed back to your original payment method.',
  },
};

function decisionNoteHtml(note: string | null): string {
  if (!note) return '';
  const escaped = note
    .split('\n')
    .map((line) => escapeHtml(line))
    .join('<br>');
  return `<p style="margin:12px 0 0;padding:12px 16px;background:#f9fafb;border-left:3px solid #1d4ed8;border-radius:4px;color:#1f2937;">${escaped}</p>`;
}

/**
 * Applies an admin decision (APPROVE / REJECT / RECEIVED / RESOLVE) through the
 * validated state machine, recording the admin identity, a decision note, an
 * append-only event, a truthful email, and — for RESOLVE of a paid, verified
 * order — the refund obligation executed against the provider.
 */
export const decideAdminReturn = asyncHandler(async (req: Request, res: Response) => {
  const id = String(req.params.id ?? '');
  const input = decideReturnSchema.parse(req.body);
  const action = input.action;

  const returnRequest = await prisma.returnRequest.findUnique({
    where: { id },
    select: {
      id: true,
      orderId: true,
      status: true,
      order: {
        select: {
          id: true,
          orderNumber: true,
          email: true,
          name: true,
          items: true,
          amount: true,
          currency: true,
          status: true,
          razorpayPaymentId: true,
        },
      },
    },
  });
  if (!returnRequest) throw ApiError.notFound('Return request not found');

  if (action === 'REJECT' && !input.note?.trim()) {
    throw ApiError.badRequest('A note is required when rejecting a return.');
  }
  const target = actionTargetFor(action, returnRequest.status);
  if (!target) {
    throw ApiError.conflict(
      `Cannot ${action} a return in status ${RETURN_STATUS_LABELS[returnRequest.status] ?? returnRequest.status}.`,
    );
  }

  const note = input.note?.trim() ?? null;
  const now = new Date();
  const order = returnRequest.order;

  // Decision is atomic: the guard is exactly (status = current) so two admins
  // acting at once can never double-apply; the loser gets a conflict.
  await prisma.$transaction(async (tx) => {
    const updated = await tx.returnRequest.updateMany({
      where: { id, status: returnRequest.status },
      data: {
        status: target,
        decisionNote: note,
        decidedBy: req.user?.name ?? null,
        decidedById: req.user?.id ?? null,
        decidedAt: now,
        closedAt: isTerminalReturnStatus(target) ? now : null,
      },
    });
    if (updated.count === 0) {
      throw ApiError.conflict('This return was already updated by someone else. Please refresh.');
    }
    await tx.orderEvent.create({
      data: {
        orderId: returnRequest.orderId,
        type: 'RETURN_REVIEWED',
        message: `Return ${action.toLowerCase()} by admin`,
        actorId: req.user?.id ?? null,
        actorName: req.user?.name ?? null,
        metadata: {
          returnId: id,
          action,
          from: returnRequest.status,
          to: target,
          ...(note ? { note } : {}),
        },
      },
    });

    // RESOLVE of a paid, verified order creates the refund obligation inside
    // this same transaction (server-side amount, verified payment id only).
    if (action === 'RESOLVE' && order.status === 'PAID' && order.razorpayPaymentId) {
      const { refund } = await createRefundInTransaction(tx, {
        orderId: returnRequest.orderId,
        amount: order.amount,
        currency: order.currency ?? 'INR',
        source: 'RETURN',
        actorId: req.user?.id ?? null,
        actorName: req.user?.name ?? null,
      });
      await tx.returnRequest.update({
        where: { id },
        data: { status: 'REFUND_INITIATED', closedAt: null, decisionNote: note },
      });
      await tx.orderEvent.create({
        data: {
          orderId: returnRequest.orderId,
          type: 'RETURN_RESOLVED',
          message: 'Return resolved with refund obligation',
          actorId: req.user?.id ?? null,
          actorName: req.user?.name ?? null,
          metadata: { returnId: id, refundId: refund.id },
        },
      });
    }
  });

  // Refund execution happens after the decision transaction commits.
  let refundOutcome: Awaited<ReturnType<typeof processRefund>> | null = null;
  if (action === 'RESOLVE' && order.status === 'PAID' && order.razorpayPaymentId) {
    const latest = await prisma.returnRequest.findUnique({
      where: { id },
      select: { orderId: true },
    });
    if (!latest) throw ApiError.notFound('Return request not found');
    const refund = await prisma.refund.findUniqueOrThrow({
      where: { orderId: latest.orderId },
      select: { id: true },
    });
    refundOutcome = await processRefund(refund.id);
    if (refundOutcome.status === 'SUCCESS') {
      await prisma.returnRequest.update({
        where: { id },
        data: { status: 'REFUND_COMPLETED', closedAt: null },
      });
    }
  }

  // Truthful decision email; the idempotency key includes the action so a
  // legitimately different later decision keeps its own copy.
  const copy = DECISION_EMAIL_COPY[action];
  const ctx = toOrderContext(order);
  const emailOutcome = await sendOrderEmail({
    orderId: order.id,
    type: 'RETURN_DECISION',
    toEmail: order.email,
    returnRequestId: id,
    mail: buildReturnDecisionEmail(ctx, {
      heading: copy.heading,
      bodyHtml: `${copy.bodyHtml}${decisionNoteHtml(note)}`,
      bodyText: `${copy.bodyText}${note ? `\n\nNote from our team: ${note}` : ''}`,
    }),
    idempotencyKey: `return-decision:${id}:${action}`,
  });

  const fresh = await prisma.returnRequest.findUnique({
    where: { id },
    select: adminReturnSelect,
  });

  res.status(200).json({
    success: true,
    data: {
      returnRequest: fresh,
      refund: refundOutcome
        ? {
            id: refundOutcome.refundId,
            status: refundOutcome.status,
            alreadyProcessed: refundOutcome.alreadyProcessed,
            error: refundOutcome.error,
          }
        : null,
      email: {
        status: emailOutcome.status,
        sent: emailOutcome.status === 'SENT',
        error: emailOutcome.error,
      },
    },
  });
});