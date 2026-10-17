import type { Request, Response } from 'express';
import { env } from '../../config/env.js';
import { prisma } from '../../lib/prisma.js';
import { ApiError } from '../../utils/ApiError.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { createReturnSchema } from '../../schemas/return.schema.js';
import { computeReturnEligibility } from './eligibility.js';
import {
  deleteReturnPhotos,
  generatePhotoId,
  validateReturnPhoto,
  type StoredPhotoMetadata,
} from './photos.js';
import { RETURN_REASON_LABELS } from './state.js';
import {
  buildReturnSubmittedEmail,
  sendOrderEmail,
  toOrderContext,
} from '../orders/orderEmails.js';

const customerReturnSelect = {
  id: true,
  reason: true,
  explanation: true,
  status: true,
  needsReview: true,
  decisionNote: true,
  decidedBy: true,
  decidedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * Starts a return request for one of the signed-in user's DELIVERED orders.
 *
 * Eligibility comes from the server-side fulfilment state (must be DELIVERED)
 * and the VERIFIED delivery timestamp, and is always within the configured
 * window. A delivered order without a verified timestamp is accepted but
 * flagged for manual review — we never guess a delivery date. Photos are
 * re-validated (magic bytes + size) and stored in a private directory.
 */
export const createReturnRequest = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const orderId = String(req.params.orderId ?? '');
  const input = createReturnSchema.parse(req.body);

  const order = await prisma.order.findFirst({
    where: { id: orderId, userId: req.user.id },
    select: {
      id: true,
      orderNumber: true,
      email: true,
      name: true,
      status: true,
      fulfillmentStatus: true,
      items: true,
      amount: true,
      currency: true,
      shipment: { select: { id: true, deliveredAt: true } },
    },
  });
  if (!order) throw ApiError.notFound('Order not found');
  if (order.fulfillmentStatus !== 'DELIVERED') {
    throw ApiError.conflict(
      'This order has not been delivered yet, so it is not eligible for a return. Contact us on WhatsApp if you need help.',
    );
  }

  const eligibility = computeReturnEligibility(
    order.fulfillmentStatus,
    order.shipment?.deliveredAt ?? null,
    env.RETURN_WINDOW_DAYS,
  );
  if (eligibility.status === 'EXPIRED') {
    throw ApiError.conflict(
      `The return window for this order ended on ${eligibility.deadline.toLocaleDateString('en-IN')}. Contact us on WhatsApp if you need help.`,
    );
  }

  const existing = await prisma.returnRequest.findFirst({
    where: { orderId, status: { notIn: ['RESOLVED', 'CLOSED'] } },
    select: { id: true, status: true },
  });
  if (existing) {
    throw ApiError.conflict('This order already has a return request under review.');
  }

  // Validate every photo FIRST against disk-persistence invariants.
  const validated: Array<{ bytes: Buffer; type: 'jpeg' | 'png' | 'webp'; originalName: string }> = [];
  for (const photo of input.photos) {
    const result = validateReturnPhoto(photo);
    if (!result.ok) throw ApiError.badRequest(result.error);
    validated.push({ bytes: result.bytes, type: result.type, originalName: photo.name });
  }

  // Persist files, then the request. If the record write fails, the files are
  // cleaned up so we never leak orphaned uploads.
  const photoId = generatePhotoId;
  const stored: StoredPhotoMetadata[] = [];
  try {
    const { writeReturnPhoto } = await import('./photos.js');
    for (const photo of validated) {
      stored.push(await writeReturnPhoto(order.id, photoId(), photo.type, photo.bytes, photo.originalName));
    }

    const created = await prisma.$transaction(async (tx) => {
      const record = await tx.returnRequest.create({
        data: {
          orderId: order.id,
          userId: req.user!.id,
          reason: input.reason,
          explanation: input.explanation,
          status: 'SUBMITTED',
          needsReview: eligibility.needsReview,
          photos: stored.map((p) => ({
            id: p.id,
            storedName: p.storedName,
            originalName: p.originalName,
            size: p.size,
            mime: p.mime,
          })),
        },
        select: customerReturnSelect,
      });
      await tx.orderEvent.create({
        data: {
          orderId: order.id,
          type: 'RETURN_REQUESTED',
          message: `Return requested (${RETURN_REASON_LABELS[input.reason] ?? input.reason})`,
          actorId: req.user?.id ?? null,
          actorName: req.user?.name ?? null,
          metadata: {
            returnId: record.id,
            reason: input.reason,
            photoCount: stored.length,
            needsReview: eligibility.needsReview,
          },
        },
      });
      return record;
    });

    // Email runs AFTER the request is committed, outside any transaction, so a
    // slow SMTP round-trip can never roll back the return request.
    const emailOutcome = await sendOrderEmail({
      orderId: order.id,
      type: 'RETURN_SUBMITTED',
      toEmail: order.email,
      returnRequestId: created.id,
      mail: buildReturnSubmittedEmail(toOrderContext(order), {
        reason: RETURN_REASON_LABELS[input.reason] ?? input.reason,
        deadlineHint: eligibility.deadline
          ? `Completed returns are processed within 5–7 business days of the item being received. The return window for this order closes on ${eligibility.deadline.toLocaleDateString('en-IN')}.`
          : null,
        needsReview: eligibility.needsReview,
      }),
      idempotencyKey: `return-submitted:${created.id}`,
    });

    res.status(201).json({
      success: true,
      data: {
        returnRequest: created,
        email: {
          status: emailOutcome.status,
          notificationId: emailOutcome.notificationId,
          sent: emailOutcome.status === 'SENT',
          error: emailOutcome.error,
        },
        message: eligibility.needsReview
          ? 'Your return request was received. We are verifying the delivery date before confirming the return window.'
          : 'Your return request was received. Our team will review it and contact you with the next steps.',
      },
    });
  } catch (err) {
    if (stored.length > 0) await deleteReturnPhotos(stored);
    throw err;
  }
});

/** The signed-in user's return request(s) for their own order. */
export const listOrderReturnRequests = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const orderId = String(req.params.orderId ?? '');
  const owned = await prisma.order.findFirst({
    where: { id: orderId, userId: req.user.id },
    select: { id: true },
  });
  if (!owned) throw ApiError.notFound('Order not found');
  const returnRequests = await prisma.returnRequest.findMany({
    where: { orderId },
    select: customerReturnSelect,
    orderBy: { createdAt: 'desc' },
  });
  res.status(200).json({ success: true, data: { returnRequests } });
});