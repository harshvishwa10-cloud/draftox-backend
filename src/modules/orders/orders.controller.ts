import type { Request, Response } from 'express';
import { z } from 'zod';
import { CancellationReason, type Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { ApiError } from '../../utils/ApiError.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { logger } from '../../lib/logger.js';
import { normalizeEmail } from '../../utils/normalize.js';
import { storeOrdersEnabled } from '../../config/env.js';
import { createOrderSchema } from '../../schemas/order.schema.js';
import { isOrderNumber, reserveOrderNumber } from './orderNumber.js';
import { canCustomerCancel, CANCELLATION_MESSAGES } from './cancellation.js';
import {
  deliveryFeeForSubtotal,
  effectiveUnitPrice,
  orderTotalForSubtotal,
} from './pricing.js';
import {
  createRefundInTransaction,
  processRefund,
  refundSelect,
  type RefundOutcome,
} from '../payments/refunds.js';
import {
  buildCancellationEmail,
  buildOrderConfirmedEmail,
  sendOrderEmail,
  toOrderContext,
} from './orderEmails.js';

const orderSelect = {
  id: true,
  orderNumber: true,
  email: true,
  name: true,
  phone: true,
  items: true,
  subtotal: true,
  amount: true,
  currency: true,
  status: true,
  fulfillmentStatus: true,
  address: true,
  paymentMethod: true,
  cancellationReason: true,
  cancellationReasonNote: true,
  createdAt: true,
  updatedAt: true,
  shipment: {
    select: {
      courierName: true,
      trackingNumber: true,
      trackingUrl: true,
      dispatchedAt: true,
      estimatedDeliveryAt: true,
      deliveredAt: true,
    },
  },
} as const;

/** Customer-facing serialization of the latest return request on an order. */
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

/** Same shape as listOrders but with payment/refund/return context. */
const orderDetailSelect = {
  ...orderSelect,
  razorpayOrderId: true,
  refund: { select: refundSelect },
  review: {
    select: { id: true, rating: true, title: true, body: true, createdAt: true },
  },
  returnRequests: {
    orderBy: { createdAt: 'desc' },
    take: 1,
    select: customerReturnSelect,
  },
} as const;

const LIST_DEFAULT_LIMIT = 20;
const LIST_MAX_LIMIT = 50;

/** Message returned when a retried checkout resolves to an existing order. */
function idempotentMessage(status: string): string {
  return status === 'CONFIRMED' || status === 'PAID'
    ? 'This order is already confirmed — returning the existing order.'
    : 'This order was already filed — returning the existing order.';
}

export const createOrder = asyncHandler(async (req: Request, res: Response) => {
  // Master ordering switch — enforced server-side, never reachable from the
  // browser. Existing orders, shipments, tracking and admin tools stay live.
  if (!storeOrdersEnabled) {
    throw ApiError.ordersDisabled(
      'Orders are paused while DRAFTOX prepares for launch. You can still ask us about a system on WhatsApp, or file a custom request below.',
    );
  }

  const input = createOrderSchema.parse(req.body);
  const isCod = input.paymentMethod === 'cod';

  // Idempotent replay: a retry that carries a key we have already seen returns
  // the original order untouched — no duplicate order and no duplicate email.
  if (input.idempotencyKey) {
    const existing = await prisma.order.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      select: orderDetailSelect,
    });
    if (existing) {
      res.status(200).json({
        success: true,
        data: { order: existing, idempotentReplay: true, message: idempotentMessage(existing.status) },
      });
      return;
    }
  }

  // Authoritative pricing: every line is re-priced from published DB rows.
  // Client-submitted totals are never trusted. Items may be identified by the
  // backend id OR the stable slug, so the storefront never has to fetch the
  // catalogue before checkout (that extra fetch was the "live catalog did not
  // return a system" failure whenever the catalog request hiccupped).
  const ids = [...new Set(input.items.map((i) => i.productId).filter(Boolean))] as string[];
  const slugs = [...new Set(input.items.map((i) => i.slug).filter(Boolean))] as string[];
  const rows = await prisma.product.findMany({
    where: {
      status: 'PUBLISHED',
      OR: [
        ...(ids.length ? [{ id: { in: ids } }] : []),
        ...(slugs.length ? [{ slug: { in: slugs } }] : []),
      ],
    },
    select: { id: true, slug: true, name: true, price: true, currency: true, image: true, warrantyMonths: true },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const bySlug = new Map(rows.map((r) => [r.slug, r]));

  const pricedItems: Array<{
    productId: string;
    slug: string;
    name: string;
    qty: number;
    unitPrice: number;
    lineTotal: number;
    image: string | null;
    warrantyMonths: number | null;
  }> = [];
  for (const item of input.items) {
    const row =
      (item.productId ? byId.get(item.productId) : undefined) ??
      (item.slug ? bySlug.get(item.slug) : undefined);
    if (!row || row.price === null) {
      throw ApiError.notFound('One or more products are unavailable');
    }
    // Local-only test override may lower the 16-channel price to a token
    // amount; in production (and without the explicit flag) this is the
    // catalogue price unchanged.
    const unitPrice = effectiveUnitPrice(row.slug, Number(row.price));
    if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
      throw ApiError.notFound('One or more products are unavailable');
    }
    pricedItems.push({
      productId: row.id,
      slug: row.slug,
      name: row.name,
      qty: item.qty,
      unitPrice,
      lineTotal: Math.round(unitPrice * item.qty * 100) / 100,
      // Immutable snapshot: the order keeps the name/price/image/warranty as
      // they were at checkout, even if the catalog changes later.
      image: row.image,
      warrantyMonths: row.warrantyMonths,
    });
  }

  const subtotal = Math.round(pricedItems.reduce((n, i) => n + i.lineTotal, 0) * 100) / 100;

  // Delivery charge is derived from the server-side subtotal (never from the
  // browser): free above the threshold, a flat fee at or below it. The order
  // total is the single authoritative amount used for Razorpay and refunds.
  const deliveryFee = deliveryFeeForSubtotal(subtotal);
  const amount = orderTotalForSubtotal(subtotal);

  // Allocate the customer-facing number and insert the order in one
  // transaction so a rollback cannot leave a half-created order or a
  // consumed-but-unused number.
  let order: Prisma.OrderGetPayload<{ select: typeof orderSelect }>;
  try {
    order = await prisma.$transaction(async (tx) => {
      const orderNumber = await reserveOrderNumber(tx);
      const created = await tx.order.create({
        data: {
          orderNumber,
          userId: req.user?.id ?? null,
          email: normalizeEmail(input.email),
          name: input.name.trim(),
          phone: input.phone ?? null,
          items: pricedItems,
          subtotal,
          amount,
          currency: 'INR',
          // COD is confirmed immediately (pay on delivery, no online charge);
          // an online order stays REQUESTED until a verified Razorpay payment.
          status: isCod ? 'CONFIRMED' : 'REQUESTED',
          ...(isCod ? { paymentMethod: 'cod' } : {}),
          ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
          address: input.address ?? undefined,
        },
        select: orderSelect,
      });
      await tx.orderEvent.create({
        data: {
          orderId: created.id,
          type: 'ORDER_CREATED',
          message: isCod ? 'Cash on Delivery order confirmed' : 'Order request received',
          metadata: {
            ...(created.orderNumber ? { orderNumber: created.orderNumber } : {}),
            ...(isCod ? { paymentMethod: 'cod' } : {}),
            subtotal,
            deliveryFee,
          },
        },
      });
      return created;
    });
  } catch (error) {
    // Race: two identical retries passed the pre-check; the unique index on
    // idempotencyKey rejected the loser. Return the winner's order.
    const code = (error as { code?: string } | null)?.code;
    if (input.idempotencyKey && code === 'P2002') {
      const existing = await prisma.order.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
        select: orderDetailSelect,
      });
      if (existing) {
        res.status(200).json({
          success: true,
          data: { order: existing, idempotentReplay: true, message: idempotentMessage(existing.status) },
        });
        return;
      }
    }
    throw error;
  }

  // COD confirmation email — sent only AFTER the order is durably committed,
  // and never allowed to fail the request (the order already exists). Stable
  // idempotency key per order so a retry can never send a second copy.
  let emailOutcome: { status: string; sent: boolean; error: string | null } | null = null;
  if (isCod) {
    try {
      // Runs outside any DB transaction so a slow SMTP round-trip can never
      // expire/roll back a transaction (the order is already durably committed).
      const outcome = await sendOrderEmail({
        orderId: order.id,
        type: 'ORDER_CONFIRMED',
        toEmail: order.email,
        mail: buildOrderConfirmedEmail(toOrderContext(order), {
          paymentMethodLabel: 'Cash on Delivery',
        }),
        idempotencyKey: `confirm:${order.id}`,
      });
      emailOutcome = { status: outcome.status, sent: outcome.status === 'SENT', error: outcome.error };
    } catch (error) {
      logger.warn('cod_confirmation_email_failed', {
        orderId: order.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  res.status(201).json({
    success: true,
    data: {
      order,
      ...(emailOutcome ? { email: emailOutcome } : {}),
      message: isCod
        ? 'Order confirmed for Cash on Delivery. No online payment was taken — pay when your order is delivered.'
        : 'Order request received. This is not a confirmed or paid order — our team will contact you to confirm configuration, installation and payment.',
    },
  });
});

export const listOrders = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();

  const rawLimit = Number(req.query.limit);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(Math.trunc(rawLimit), 1), LIST_MAX_LIMIT)
    : LIST_DEFAULT_LIMIT;
  const cursor =
    typeof req.query.cursor === 'string' && req.query.cursor.trim() ? req.query.cursor.trim() : null;

  // Newest first. Fetch one extra row to know whether another page exists.
  const rows = await prisma.order.findMany({
    where: { userId: req.user.id },
    select: orderSelect,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > limit;
  const orders = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore && orders.length > 0 ? orders[orders.length - 1].id : null;

  res.status(200).json({ success: true, data: { orders, nextCursor } });
});

export const getOrder = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const id = String(req.params.id ?? '');
  const order = await prisma.order.findFirst({
    where: { id, userId: req.user.id },
    select: orderDetailSelect,
  });
  if (!order) throw ApiError.notFound('Order not found');
  res.status(200).json({ success: true, data: { order } });
});

/**
 * Fetches one of the signed-in user's orders by its 5-digit customer number.
 * A malformed number, an unknown number, or another customer's number all
 * return the same 404 so no order existence or detail ever leaks.
 */
export const getOrderByNumber = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const orderNumber = String(req.params.orderNumber ?? '').trim();
  if (!isOrderNumber(orderNumber)) throw ApiError.notFound('Order not found');
  const order = await prisma.order.findFirst({
    where: { orderNumber, userId: req.user.id },
    select: orderDetailSelect,
  });
  if (!order) throw ApiError.notFound('Order not found');
  res.status(200).json({ success: true, data: { order } });
});

const cancelOrderSchema = z
  .object({
    // The typed reason is required for a FRESH cancellation (enforced below,
    // after eligibility). It stays optional at parse time so the idempotent
    // already-cancelled path and foreign/malformed-order 404s still work.
    reason: z.nativeEnum(CancellationReason).optional(),
    reasonNote: z.string().trim().max(500).optional(),
  })
  .strict();

/**
 * Cancels one of the signed-in user's orders.
 *
 * The flow is safe under concurrency and is never gated by the store switch
 * (cancellation always works while orders are paused):
 *   1. Server-side ownership check — someone else's order is a 404, never a
 *      hint that it exists.
 *   2. Eligibility from the pure state machine. Already-cancelled orders return
 *      an idempotent 200 (nothing changes, no duplicate email via the stable
 *      idempotency key). DELIVERED / with-courier orders get a truthful 409
 *      that points at the return process instead.
 *   3. Atomic transition (guarded updateMany) + append-only ORDER_CANCELLED_BY_
 *      CUSTOMER event.
 *   4. A PAID order gets a refund obligation inside the cancellation transaction
 *      (never fabricated, full server-side amount), then a provider attempt.
 *   5. A truthful cancellation email is enqueued/sent (idempotent per order).
 */
async function cancelOwnedOrder(req: Request, res: Response, where: () => Prisma.OrderWhereInput) {
  if (!req.user) throw ApiError.unauthorized();
  const userId = req.user.id;
  const userName = req.user.name;
  const input = cancelOrderSchema.parse(req.body ?? {});

  const order = await prisma.order.findFirst({
    where: where(),
    select: {
      id: true,
      orderNumber: true,
      email: true,
      name: true,
      status: true,
      fulfillmentStatus: true,
      amount: true,
      currency: true,
      razorpayPaymentId: true,
      items: true,
    },
  });
  if (!order) throw ApiError.notFound('Order not found');

  const eligibility = canCustomerCancel(order);
  if (!eligibility.allowed && eligibility.reason !== 'ALREADY_CANCELLED') {
    throw ApiError.conflict(CANCELLATION_MESSAGES[eligibility.reason]);
  }

  // A fresh cancellation must carry a valid, typed reason so the team learns why.
  // A repeat on an already-cancelled order stays idempotent and does NOT require
  // a reason (so a naive retry still succeeds).
  if (eligibility.allowed && !input.reason) {
    throw ApiError.badRequest('Please select a reason for cancelling the order.');
  }

  if (eligibility.allowed) {
    await prisma.$transaction(async (tx) => {
      const cancelled = await tx.order.updateMany({
        where: { id: order.id, status: { not: 'CANCELLED' } },
        data: {
          // Store the reason on the order for fast admin display; the event below
          // keeps the append-only audit copy.
          cancellationReason: input.reason,
          cancellationReasonNote: input.reasonNote?.trim() ? input.reasonNote.trim() : null,
          // A PAID order is never flattened to CANCELLED: the verified payment
          // record must stay intact so the refund leg can complete against it.
          // Only its fulfilment is cancelled here.
          ...(order.status !== 'PAID' ? { status: 'CANCELLED' } : {}),
        },
      });
      await tx.order.updateMany({
        where: { id: order.id, fulfillmentStatus: { not: 'CANCELLED' } },
        data: { fulfillmentStatus: 'CANCELLED' },
      });
      // Only the request that actually turns the status records the event.
      if (cancelled.count > 0) {
        await tx.orderEvent.create({
          data: {
            orderId: order.id,
            type: 'ORDER_CANCELLED_BY_CUSTOMER',
            message: 'Order cancelled by customer',
            actorId: userId,
            actorName: userName,
            metadata: {
              via: 'customer',
              ...(input.reason ? { reason: input.reason } : {}),
              ...(input.reasonNote?.trim() ? { reasonNote: input.reasonNote.trim() } : {}),
            },
          },
        });
      }
    });
  }

  // Refund obligation for a paid cancellation. createRefundInTransaction is
  // idempotent (unique orderId); processRefund is guarded so a double-tap or a
  // later retry can never double-post to the provider.
  const after = await prisma.order.findUnique({
    where: { id: order.id },
    select: { status: true, razorpayPaymentId: true, amount: true, currency: true, orderNumber: true },
  });
  let refundOutcome: RefundOutcome | null = null;
  if (after?.status === 'PAID' && after.razorpayPaymentId) {
    const { refund } = await prisma.$transaction((tx) =>
      createRefundInTransaction(tx, {
        orderId: order.id,
        amount: after.amount,
        currency: after.currency ?? 'INR',
        source: 'CANCEL',
        actorId: userId,
        actorName: userName,
      }),
    );
    refundOutcome = await processRefund(refund.id);
  }

  const refundMessage = refundOutcome
    ? refundOutcome.status === 'SUCCESS'
      ? 'Your prepaid amount has been refunded to your original payment method.'
      : 'Your refund has been initiated and will be sent to your original payment method as soon as the payment provider processes it.'
    : null;

  // Truthful cancellation email. Stable idempotency key per order — a repeat of
  // this request (already-cancelled path) can never send a second copy.
  const cancelContext = toOrderContext(order);
  const emailOutcome = await sendOrderEmail({
    orderId: order.id,
    type: 'ORDER_CANCELLED',
    toEmail: order.email,
    mail: buildCancellationEmail(cancelContext, {
      refundPending: Boolean(refundOutcome),
      refundMessage,
    }),
    idempotencyKey: `cancel:${order.id}`,
  });

  const full = await prisma.order.findUnique({
    where: { id: order.id },
    select: orderDetailSelect,
  });

  res.status(200).json({
    success: true,
    data: {
      order: full,
      alreadyCancelled: !eligibility.allowed,
      refund: refundOutcome
        ? {
            status: refundOutcome.status,
            provider: refundOutcome.provider,
            alreadyProcessed: refundOutcome.alreadyProcessed,
            error: refundOutcome.error,
          }
        : null,
      email: {
        status: emailOutcome.status,
        notificationId: emailOutcome.notificationId,
        sent: emailOutcome.status === 'SENT',
        error: emailOutcome.error,
      },
    },
  });
}

export const cancelOrderById = asyncHandler(async (req: Request, res: Response) => {
  const id = String(req.params.id ?? '');
  await cancelOwnedOrder(req, res, () => ({ id, userId: req.user?.id }));
});

/** Cancels by customer-facing number; malformed/foreign numbers → same 404. */
export const cancelOrderByNumber = asyncHandler(async (req: Request, res: Response) => {
  const orderNumber = String(req.params.orderNumber ?? '').trim();
  if (!isOrderNumber(orderNumber)) throw ApiError.notFound('Order not found');
  await cancelOwnedOrder(req, res, () => ({ orderNumber, userId: req.user?.id }));
});
