import type { Request, Response } from 'express';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { ApiError } from '../../utils/ApiError.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import {
  adminOrderListQuerySchema,
  updateFulfillmentSchema,
  upsertShipmentSchema,
} from '../../schemas/admin.schema.js';
import {
  allowedFulfillmentTransitions,
  canTransitionFulfillment,
  fulfillmentRequiresPaid,
} from '../orders/fulfillment.js';
import {
  generateTrackingToken,
  type DeliveryOutcome,
  type DeliveryStatus,
  type OrderInfo,
  type ShipmentDetails,
} from '../shipping/notifications.js';
import {
  createRefundInTransaction,
  processRefund,
  refundSelect,
  type RefundOutcome,
} from '../payments/refunds.js';
import { retryOrderNotification } from '../orders/orderEmails.js';

const LIST_DEFAULT_LIMIT = 20;
const LIST_MAX_LIMIT = 100;

const shipmentSelect = {
  id: true,
  courierName: true,
  trackingNumber: true,
  trackingUrl: true,
  dispatchNotes: true,
  dispatchedAt: true,
  estimatedDeliveryAt: true,
  deliveredAt: true,
  trackingToken: true,
  trackingTokenCreatedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

const adminReturnRequestSelect = {
  id: true,
  reason: true,
  explanation: true,
  status: true,
  needsReview: true,
  photos: true,
  decisionNote: true,
  decidedBy: true,
  decidedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

const adminOrderListSelect = {
  id: true,
  orderNumber: true,
  name: true,
  email: true,
  phone: true,
  items: true,
  subtotal: true,
  amount: true,
  currency: true,
  status: true,
  fulfillmentStatus: true,
  paymentMethod: true,
  address: true,
  cancellationReason: true,
  cancellationReasonNote: true,
  createdAt: true,
  updatedAt: true,
  shipment: { select: shipmentSelect },
} as const;

export const adminOrderDetailSelect = {
  ...adminOrderListSelect,
  userId: true,
  razorpayOrderId: true,
  razorpayPaymentId: true,
  events: {
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      type: true,
      message: true,
      actorId: true,
      actorName: true,
      metadata: true,
      createdAt: true,
    },
  },
  notifications: {
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: {
      id: true,
      type: true,
      status: true,
      toEmail: true,
      provider: true,
      attempts: true,
      messageId: true,
      error: true,
      sentAt: true,
      createdAt: true,
    },
  },
  refund: { select: refundSelect },
  returnRequests: {
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: adminReturnRequestSelect,
  },
} as const;

/** Admin display name to attribute an action to (id is always retained). */
export function actorName(req: Request): string | null {
  return req.user?.name ?? null;
}

/**
 * Lists every order (all customers) for admins, newest first, with optional
 * search and status filters, plus cursor pagination.
 */
export const listAdminOrders = asyncHandler(async (req: Request, res: Response) => {
  const query = adminOrderListQuerySchema.parse(req.query);

  const limit = Math.min(query.limit ?? LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT);

  const where: Prisma.OrderWhereInput = {};
  if (query.paymentStatus) where.status = query.paymentStatus;
  if (query.fulfillmentStatus) where.fulfillmentStatus = query.fulfillmentStatus;

  if (query.q) {
    const q = query.q;
    // A bare number searches the customer-facing order number; otherwise the
    // search matches the customer's name/email/phone.
    const numeric = /^\d{1,6}$/.test(q) ? q : null;
    const or: Prisma.OrderWhereInput[] = [
      { name: { contains: q, mode: 'insensitive' } },
      { email: { contains: q, mode: 'insensitive' } },
      { phone: { contains: q } },
    ];
    if (numeric) or.unshift({ orderNumber: { contains: numeric } });
    where.OR = or;
  }

  const rows = await prisma.order.findMany({
    where,
    select: adminOrderListSelect,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > limit;
  const orders = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore && orders.length > 0 ? orders[orders.length - 1].id : null;

  res.status(200).json({ success: true, data: { orders, nextCursor } });
});

async function loadOrderForAdmin(id: string) {
  const order = await prisma.order.findUnique({
    where: { id },
    select: { id: true, status: true, fulfillmentStatus: true, orderNumber: true, paymentMethod: true },
  });
  if (!order) throw ApiError.notFound('Order not found');
  return order;
}

/** Full order detail: snapshots, address, verified payment data, shipment, history. */
export const getAdminOrder = asyncHandler(async (req: Request, res: Response) => {
  const id = String(req.params.id ?? '');
  const order = await prisma.order.findUnique({
    where: { id },
    select: adminOrderDetailSelect,
  });
  if (!order) throw ApiError.notFound('Order not found');
  res.status(200).json({
    success: true,
    data: {
      order,
      fulfillment: {
        current: order.fulfillmentStatus,
        allowedTransitions: allowedFulfillmentTransitions(order.fulfillmentStatus),
      },
    },
  });
});

/**
 * Advances the fulfilment status through the validated state machine. Payment
 * status is never touched except to cancel an unpaid order; a paid order keeps
 * its PAID payment status when its fulfilment is cancelled.
 */
export const updateOrderFulfillment = asyncHandler(async (req: Request, res: Response) => {
  const id = String(req.params.id ?? '');
  const input = updateFulfillmentSchema.parse(req.body);

  const current = await loadOrderForAdmin(id);

  if (input.status === current.fulfillmentStatus) {
    throw ApiError.badRequest(`Order is already ${input.status}`);
  }
  if (!canTransitionFulfillment(current.fulfillmentStatus, input.status)) {
    throw ApiError.conflict(
      `Cannot move from ${current.fulfillmentStatus} to ${input.status}. Allowed: ${
        allowedFulfillmentTransitions(current.fulfillmentStatus).join(', ') || 'none'
      }`,
    );
  }
  if (fulfillmentRequiresPaid(input.status) && current.status !== 'PAID' && current.paymentMethod !== 'cod') {
    throw ApiError.conflict(
      'Payment must be verified before the order can move beyond awaiting payment',
    );
  }

  const cancelling = input.status === 'CANCELLED';
  const delivering = input.status === 'DELIVERED';
  const eventType = cancelling ? 'ORDER_CANCELLED' : 'FULFILLMENT_CHANGED';

  // The fulfillment transition, the DELIVERED timestamp and a paid-order refund
  // obligation (if any) are committed atomically. Refund EXECUTION runs after
  // commit so a provider outage can never leave the state machine broken.
  const { refund } = await prisma.$transaction(async (tx) => {
    let createdRefund: { id: string; status: string } | null = null;
    if (cancelling && current.status === 'PAID') {
      const paid = await tx.order.findUnique({
        where: { id },
        select: { amount: true, currency: true, razorpayPaymentId: true },
      });
      if (paid?.razorpayPaymentId) {
        const created = await createRefundInTransaction(tx, {
          orderId: id,
          amount: paid.amount,
          currency: paid.currency ?? 'INR',
          source: 'ADMIN',
          actorId: req.user?.id ?? null,
          actorName: actorName(req),
        });
        createdRefund = created.refund;
      }
    }

    await tx.order.update({
      where: { id },
      data: {
        fulfillmentStatus: input.status,
        // Only an unpaid order's payment/order status is cancelled; a paid
        // order keeps its verified payment record intact (refund is initiated).
        ...(cancelling && current.status !== 'PAID' ? { status: 'CANCELLED' } : {}),
      },
    });
    if (delivering) {
      // DeliveredAt is stamped once, from the admin-side DELIVERED transition.
      // It becomes the server-side anchor for return-window eligibility.
      await tx.shipment.updateMany({
        where: { orderId: id },
        data: { deliveredAt: new Date() },
      });
    }
    await tx.orderEvent.create({
      data: {
        orderId: id,
        type: eventType,
        message:
          input.note ??
          (delivering
            ? `Fulfilment: ${current.fulfillmentStatus} → DELIVERED`
            : `Fulfilment: ${current.fulfillmentStatus} → ${input.status}`),
        actorId: req.user?.id ?? null,
        actorName: actorName(req),
        metadata: {
          from: current.fulfillmentStatus,
          to: input.status,
          ...(delivering ? { deliveredAt: new Date().toISOString() } : {}),
          ...(createdRefund ? { refundId: createdRefund.id } : {}),
          ...(input.note ? { note: input.note } : {}),
        },
      },
    });
    return { refund: createdRefund };
  });

  // Provider work happens after commit and never holds a DB transaction open.
  let refundOutcome: RefundOutcome | null = null;
  if (refund) {
    refundOutcome = await processRefund(refund.id);
  }

  const order = await prisma.order.findUnique({ where: { id }, select: adminOrderDetailSelect });
  res.status(200).json({
    success: true,
    data: {
      order,
      fulfillment: order
        ? {
            current: order.fulfillmentStatus,
            allowedTransitions: allowedFulfillmentTransitions(order.fulfillmentStatus),
          }
        : null,
      refund: refundOutcome
        ? {
            id: refundOutcome.refundId,
            status: refundOutcome.status,
            alreadyProcessed: refundOutcome.alreadyProcessed,
            error: refundOutcome.error,
          }
        : null,
    },
  });
});

interface ShipmentData {
  courierName?: string | null;
  trackingNumber?: string | null;
  trackingUrl?: string | null;
  dispatchNotes?: string | null;
  dispatchedAt?: Date | null;
  estimatedDeliveryAt?: Date | null;
}

function buildShipmentData(input: ShipmentData): ShipmentData {
  const data: ShipmentData = {};
  if (input.courierName !== undefined) data.courierName = input.courierName;
  if (input.trackingNumber !== undefined) data.trackingNumber = input.trackingNumber;
  if (input.trackingUrl !== undefined) data.trackingUrl = input.trackingUrl;
  if (input.dispatchNotes !== undefined) data.dispatchNotes = input.dispatchNotes;
  if (input.dispatchedAt !== undefined) data.dispatchedAt = input.dispatchedAt;
  if (input.estimatedDeliveryAt !== undefined) data.estimatedDeliveryAt = input.estimatedDeliveryAt;
  return data;
}

/**
 * Saves courier/tracking information for an order. No real courier booking is
 * made — this only records admin-supplied details. Requires verified payment
 * (a shipment on an unpaid order is not allowed) and a non-cancelled order.
 *
 * When this is the first shipment save for the order, a tracking token is
 * generated (stable for the lifetime of the shipment) and an INITIAL shipment
 * email is enqueued/sent automatically. Subsequent saves only update details;
 * no additional automatic email is sent unless an admin explicitly triggers one.
 */
export const upsertOrderShipment = asyncHandler(async (req: Request, res: Response) => {
  const id = String(req.params.id ?? '');
  const input = upsertShipmentSchema.parse(req.body);

  const current = await loadOrderForAdmin(id);
  if (current.fulfillmentStatus === 'CANCELLED') {
    throw ApiError.conflict('Cannot record shipment details for a cancelled order');
  }
  if (current.status !== 'PAID' && current.paymentMethod !== 'cod') {
    throw ApiError.conflict('Payment must be verified before shipment details can be recorded');
  }

  const data = buildShipmentData(input);

  const shipment = await prisma.$transaction(async (tx) => {
    // First load: determine whether we're creating (needs token) or updating.
    const existing = await tx.shipment.findUnique({
      where: { orderId: id },
      select: { id: true, trackingToken: true },
    });

    const isCreate = !existing || !existing.trackingToken;
    const trackingToken = isCreate ? generateTrackingToken() : existing.trackingToken;

    const saved = await tx.shipment.upsert({
      where: { orderId: id },
      create: {
        orderId: id,
        courierName: input.courierName ?? null,
        trackingNumber: input.trackingNumber ?? null,
        trackingUrl: input.trackingUrl ?? null,
        dispatchNotes: input.dispatchNotes ?? null,
        dispatchedAt: input.dispatchedAt ?? null,
        estimatedDeliveryAt: input.estimatedDeliveryAt ?? null,
        trackingToken,
        trackingTokenCreatedAt: isCreate ? new Date() : null,
      },
      update: {
        ...data,
        trackingToken: undefined,
        trackingTokenCreatedAt: undefined,
      },
      select: shipmentSelect,
    });

    await tx.orderEvent.create({
      data: {
        orderId: id,
        type: 'SHIPMENT_UPDATED',
        message: input.trackingNumber
          ? `Shipment details saved (AWB ${input.trackingNumber})`
          : 'Shipment details updated',
        actorId: req.user?.id ?? null,
        actorName: actorName(req),
        metadata: {
          ...(input.courierName !== undefined ? { courierName: input.courierName } : {}),
          ...(input.trackingNumber !== undefined ? { trackingNumber: input.trackingNumber } : {}),
          ...(input.trackingUrl !== undefined ? { trackingUrl: input.trackingUrl } : {}),
          ...(isCreate ? { trackingTokenIssued: true } : {}),
        },
      },
    });

    // The email is NOT sent inside this transaction: a slow SMTP round-trip
    // must never hold the DB transaction open (Prisma's default 5s interactive
    // timeout would expire mid-send and roll back the shipment). We capture the
    // recipient context here and send AFTER the transaction commits.
    const orderForEmail = isCreate
      ? await tx.order.findUnique({
          where: { id },
          select: {
            orderNumber: true,
            email: true,
            name: true,
            address: true,
            items: true,
            amount: true,
            currency: true,
          },
        })
      : null;

    return { shipment: saved, trackingToken: trackingToken!, orderForEmail };
  });

  // Send the initial shipment email when a brand-new shipment with a tracking
  // token was recorded. It is idempotent per order and never re-sent on later
  // edits. It runs after commit so a slow provider can never roll back the
  // shipment, and its truthful outcome is surfaced to the admin UI separately
  // from the "shipment saved" result.
  let emailOutcome: DeliveryOutcome | null = null;
  if (shipment.orderForEmail) {
    const { sendInitialShipmentEmail } = await import('../shipping/notifications.js');
    const orderForEmail = shipment.orderForEmail;
    const orderInfo: OrderInfo = {
      orderNumber: orderForEmail.orderNumber,
      email: orderForEmail.email,
      name: orderForEmail.name,
      address: orderForEmail.address as OrderInfo['address'],
      items: orderForEmail.items as OrderInfo['items'],
      amount: orderForEmail.amount,
      currency: orderForEmail.currency ?? 'INR',
    };
    const shipmentDetails: ShipmentDetails = {
      courierName: shipment.shipment.courierName,
      trackingNumber: shipment.shipment.trackingNumber,
      trackingUrl: shipment.shipment.trackingUrl,
      dispatchNotes: shipment.shipment.dispatchNotes,
      dispatchedAt: shipment.shipment.dispatchedAt,
      estimatedDeliveryAt: shipment.shipment.estimatedDeliveryAt,
    };
    emailOutcome = await sendInitialShipmentEmail(
      id,
      orderInfo,
      shipmentDetails,
      shipment.trackingToken,
    );
  }

  // Shipment saving and email delivery are reported separately and truthfully.
  // `initialEmailSent` is true ONLY when the provider accepted the message.
  const email = emailOutcome;
  res.status(200).json({
    success: true,
    data: {
      shipment: shipment.shipment,
      initialEmailSent: email?.status === 'SENT',
      email: email
        ? {
            status: email.status,
            notificationId: email.notificationId,
            sent: email.status === 'SENT',
            error: email.error,
          }
        : {
            // No automatic email is sent on later edits to an existing shipment.
            status: 'SKIPPED' as const,
            notificationId: null,
            sent: false,
            error: null,
          },
    },
  });
});

/** Schema for the optional note + idempotency key on an update-email request. */
const sendUpdateEmailSchema = z
  .object({
    note: z.string().trim().max(500).optional(),
    idempotencyKey: z.string().trim().min(8).max(120).optional(),
  })
  .strict();

/** Human-readable, truthful message for a retry outcome. */
function retryMessage(status: DeliveryStatus): string {
  switch (status) {
    case 'SENT':
      return 'Email accepted by the provider after retry.';
    case 'ALREADY_SENT':
      return 'This email was already accepted by the provider — not sent again.';
    case 'NOT_CONFIGURED':
      return 'Email delivery is not configured. Set EMAIL_PROVIDER=smtp to enable retries.';
    case 'NO_RECIPIENT':
      return 'This order has no customer email address to send to.';
    default:
      return 'The email provider did not accept the message. Please try again later.';
  }
}

/**
 * Re-attempts delivery of a single PENDING or FAILED shipment notification
 * (INITIAL or UPDATE). An already-accepted (SENT) notification is never
 * re-sent, so repeated retries can never duplicate the email.
 */
export const retryShipmentNotification = asyncHandler(async (req: Request, res: Response) => {
  const notificationId = String(req.params.id ?? '');

  // The retry performs the SMTP send itself (outside any transaction) so a slow
  // provider can never hold a DB transaction open or roll it back.
  const { retryNotification } = await import('../shipping/notifications.js');
  const result = await retryNotification(notificationId);

  res.status(200).json({
    success: true,
    data: { notificationId, status: result, sent: result === 'SENT' },
    message: retryMessage(result),
  });
});

/**
 * Triggers an explicit UPDATE shipment email for an order that already has a
 * shipment with a tracking token. Creates a new UPDATE notification row and
 * attempts delivery. The order must be paid and have a shipment with a token.
 */
export const sendShipmentUpdateEmail = asyncHandler(async (req: Request, res: Response) => {
  const id = String(req.params.id ?? '');
  const input = sendUpdateEmailSchema.parse(req.body ?? {});

  const { prisma } = await import('../../lib/prisma.js');
  const order = await prisma.order.findUnique({
    where: { id },
    select: {
      id: true,
      orderNumber: true,
      email: true,
      name: true,
      address: true,
      items: true,
      amount: true,
      currency: true,
      status: true,
      paymentMethod: true,
      fulfillmentStatus: true,
      shipment: {
        select: {
          id: true,
          courierName: true,
          trackingNumber: true,
          trackingUrl: true,
          dispatchNotes: true,
          dispatchedAt: true,
          estimatedDeliveryAt: true,
          trackingToken: true,
        },
      },
    },
  });

  if (!order) throw ApiError.notFound('Order not found');
  if (order.fulfillmentStatus === 'CANCELLED') {
    throw ApiError.conflict('Cannot send a tracking update for a cancelled order');
  }
  // A verified (PAID) order always qualifies. A Cash-on-Delivery order is
  // CONFIRMED and never becomes PAID — it is legitimately allowed to receive
  // tracking updates and dispatch emails.
  const codConfirmed = order.status === 'CONFIRMED' && order.paymentMethod === 'cod';
  if (order.status !== 'PAID' && !codConfirmed) {
    throw ApiError.conflict('Payment must be verified before a tracking update email');
  }
  if (!order.shipment?.trackingToken) {
    throw ApiError.conflict('No tracking token available — save shipment details first');
  }

  const orderInfo: OrderInfo = {
    orderNumber: order.orderNumber,
    email: order.email,
    name: order.name,
    address: order.address as OrderInfo['address'],
    items: order.items as OrderInfo['items'],
    amount: order.amount,
    currency: order.currency ?? 'INR',
  };
  const shipmentDetails: ShipmentDetails = {
    courierName: order.shipment.courierName,
    trackingNumber: order.shipment.trackingNumber,
    trackingUrl: order.shipment.trackingUrl,
    dispatchNotes: order.shipment.dispatchNotes,
    dispatchedAt: order.shipment.dispatchedAt,
    estimatedDeliveryAt: order.shipment.estimatedDeliveryAt,
  };

  // The send runs outside any transaction: a slow SMTP round-trip must never
  // hold a DB transaction open or be rolled back by one.
  const { sendUpdateShipmentEmail } = await import('../shipping/notifications.js');
  const outcome = await sendUpdateShipmentEmail(
    id,
    shipmentDetails,
    order.shipment!.trackingToken!,
    orderInfo,
    input.note ?? null,
    order.shipment!.id,
    input.idempotencyKey ?? null,
  );

  res.status(200).json({
    success: true,
    data: {
      notificationId: outcome.notificationId,
      status: outcome.status,
      sent: outcome.status === 'SENT',
      error: outcome.error,
    },
    message:
      outcome.status === 'SENT'
        ? 'Tracking update email accepted by the provider.'
        : outcome.status === 'ALREADY_SENT'
          ? 'This update email was already sent — not sent again.'
          : 'The tracking update email could not be sent.',
  });
});

/**
 * Re-attempts a pending/failed refund (REQUESTED / FAILED / MANUAL_REVIEW).
 * processRefund is guarded, so a SENT retry can never double-post and a
 * concurrent retry simply reports the current truth.
 */
export const retryRefund = asyncHandler(async (req: Request, res: Response) => {
  const refundId = String(req.params.id ?? '');
  const outcome = await processRefund(refundId);

  const { REFUND_LABELS } = await import('../payments/refunds.js');
  res.status(200).json({
    success: true,
    data: {
      id: outcome.refundId,
      status: outcome.status,
      statusLabel: REFUND_LABELS[outcome.status] ?? outcome.status,
      alreadyProcessed: outcome.alreadyProcessed,
      error: outcome.error,
    },
    message:
      outcome.status === 'SUCCESS'
        ? 'Refund confirmed as completed by the payment provider.'
        : outcome.status === 'MANUAL_REVIEW'
          ? 'This refund needs a team member to complete it manually.'
          : outcome.status === 'FAILED'
            ? 'The refund attempt failed. It stays retryable.'
            : 'Refund retry accepted.',
  });
});

/** Re-attempts a single PENDING/FAILED order notification (cancellation/return). */
export const retryOrderEmail = asyncHandler(async (req: Request, res: Response) => {
  const notificationId = String(req.params.id ?? '');
  const result = await retryOrderNotification(notificationId);

  res.status(200).json({
    success: true,
    data: { notificationId, status: result, sent: result === 'SENT' },
    message:
      result === 'SENT'
        ? 'Email accepted by the provider after retry.'
        : result === 'ALREADY_SENT'
          ? 'This email was already accepted by the provider — not sent again.'
          : result === 'NOT_CONFIGURED'
            ? 'Email delivery is not configured. Set EMAIL_PROVIDER=smtp to enable retries.'
            : result === 'NO_RECIPIENT'
              ? 'This notification has no customer email address to send to.'
              : 'The email provider did not accept the message. Please try again later.',
  });
});
