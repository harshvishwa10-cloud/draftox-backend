import type { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { ApiError } from '../../utils/ApiError.js';
import { asyncHandler } from '../../utils/asyncHandler.js';

/**
 * Optional post-order review of the DRAFTOX ordering experience. One review per
 * order, owned by the signed-in customer who placed it. Reviews are NOT gated on
 * delivery (this is an ordering-experience review, requested right after an
 * order is confirmed), so a COD order — which is never "paid" — can still be
 * reviewed by its owner. Guests (orders with no user) cannot review.
 */

const createReviewSchema = z
  .object({
    orderId: z.string().trim().min(1).max(200),
    rating: z.number().int().min(1).max(5),
    title: z.string().trim().max(120).optional(),
    body: z.string().trim().max(2000).optional(),
  })
  .strict();

const reviewSelect = {
  id: true,
  orderId: true,
  rating: true,
  title: true,
  body: true,
  createdAt: true,
} as const;

export const createReview = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const input = createReviewSchema.parse(req.body);

  // Ownership is the authorization boundary: a foreign order is indistinguishable
  // from a missing one (404), and only the order's owner may review it.
  const order = await prisma.order.findFirst({
    where: { id: input.orderId, userId: req.user.id },
    select: { id: true, review: { select: { id: true } } },
  });
  if (!order) throw ApiError.notFound('Order not found');
  if (order.review) throw ApiError.conflict('You have already reviewed this order.');

  try {
    const review = await prisma.review.create({
      data: {
        orderId: order.id,
        userId: req.user.id,
        rating: input.rating,
        title: input.title ?? null,
        body: input.body ?? null,
      },
      select: reviewSelect,
    });
    res.status(201).json({
      success: true,
      data: { review },
      message: 'Thank you for the feedback!',
    });
  } catch (err) {
    // Unique orderId: a concurrent submit loses the race and reports a conflict.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw ApiError.conflict('You have already reviewed this order.');
    }
    throw err;
  }
});

/** The signed-in user's own reviews, newest first. */
export const listMyReviews = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const reviews = await prisma.review.findMany({
    where: { userId: req.user.id },
    select: {
      ...reviewSelect,
      order: { select: { orderNumber: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  res.status(200).json({ success: true, data: { reviews } });
});
