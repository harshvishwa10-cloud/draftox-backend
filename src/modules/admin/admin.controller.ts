import type { Request, Response } from 'express';
import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { ApiError } from '../../utils/ApiError.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import {
  adminOrderListQuerySchema,
  deliverOrderSchema,
  resendDeliveryEmailSchema,
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

/** Delivery-relevant shipment fields, used for change detection + fingerprints. */
const SHIPMENT_FIELDS = [
  'courierName',
  'trackingNumber',
  'trackingUrl',
  'dispatchNotes',
  'dispatchedAt',
  'estimatedDeliveryAt',
] as const;

interface ShipmentValues {
  courierName: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  dispatchNotes: string | null;
  dispatchedAt: Date | null;
  estimatedDeliveryAt: Date | null;
}

function shipmentValues(row: ShipmentValues | null): ShipmentValues {
  return {
    courierName: row?.courierName ?? null,
    trackingNumber: row?.trackingNumber ?? null,
    trackingUrl: row?.trackingUrl ?? null,
    dispatchNotes: row?.dispatchNotes ?? null,
    dispatchedAt: row?.dispatchedAt ?? null,
    estimatedDeliveryAt: row?.estimatedDeliveryAt ?? null,
  };
}

/** Field-by-field comparison; Date objects are compared by timestamp. */
function shipmentFieldValuesEqual(
  left: string | Date | null,
  right: string | Date | null,
): boolean {
  if (left instanceof Date || right instanceof Date) {
    const lt = left instanceof Date ? left.getTime() : null;
    const rt = right instanceof Date ? right.getTime() : null;
    return lt === rt;
  }
  return left === right;
}

function shipmentValuesEqual(a: ShipmentValues, b: ShipmentValues): boolean {
  return SHIPMENT_FIELDS.every((field) => shipmentFieldValuesEqual(a[field], b[field]));
}

/**
 * Stable fingerprint of a previous→next transition. Two concurrent/duplicate
 * saves that apply the same change produce the same idempotency key, so the
 * email outbox can never send a second copy. Changing the shipment again — or
 * reverting it — produces a different key and a genuine update email.
 */
function shipmentChangeFingerprint(prev: ShipmentValues, next: ShipmentValues): string {
  const serialise = (values: ShipmentValues) => ({
    courierName: values.courierName,
    trackingNumber: values.trackingNumber,
    trackingUrl: values.trackingUrl,
    dispatchNotes: values.dispatchNotes,
    dispatchedAt: values.dispatchedAt?.toISOString() ?? null,
    estimatedDeliveryAt: values.estimatedDeliveryAt?.toISOString() ?? null,
  });
  return createHash('sha256')
    .update(JSON.stringify({ prev: serialise(prev), next: serialise(next) }))
    .digest('hex')
    .slice(0, 40);
}

/**
 * Saves courier/tracking information for an order. No real courier booking is
 * made — this only records admin-supplied details. Requires verified payment
 * (a shipment on an unpaid order is not allowed) and a non-cancelled order.
 *
 * The first save generates a stable tracking token and sends the INITIAL
 * delivery email automatically. Later saves send an UPDATE email only when a
 * delivery-relevant field actually changed; an identical re-save is a no-op
 * (no event, no email). Saves are idempotent per change, so a double-click or a
 * retried request can never send a duplicate email. Email delivery is attempted
 * AFTER the details are committed — a provider failure never loses the saved
 * details, and the failed notification stays retryable.
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

  const result = await prisma.$transaction(async (tx) => {
    const existing = await tx.shipment.findUnique({
      where: { orderId: id },
      select: {
        id: true,
        trackingToken: true,
        courierName: true,
        trackingNumber: true,
        trackingUrl: true,
        dispatchNotes: true,
        dispatchedAt: true,
        estimatedDeliveryAt: true,
      },
    });

    const isCreate = !existing || !existing.trackingToken;
    const prev = shipmentValues(existing);
    const next: ShipmentValues = {
      courierName: input.courierName !== undefined ? input.courierName : prev.courierName,
      trackingNumber:
        input.trackingNumber !== undefined ? input.trackingNumber : prev.trackingNumber,
      trackingUrl: input.trackingUrl !== undefined ? input.trackingUrl : prev.trackingUrl,
      dispatchNotes: input.dispatchNotes !== undefined ? input.dispatchNotes : prev.dispatchNotes,
      dispatchedAt: input.dispatchedAt !== undefined ? input.dispatchedAt : prev.dispatchedAt,
      estimatedDeliveryAt:
        input.estimatedDeliveryAt !== undefined
          ? input.estimatedDeliveryAt
          : prev.estimatedDeliveryAt,
    };
    const changed = isCreate || !shipmentValuesEqual(prev, next);

    // Nothing changed: leave the stored row (and its updatedAt) untouched and
    // send no email. This is what makes repeated submissions harmless.
    if (!changed) {
      const unchanged = await tx.shipment.findUniqueOrThrow({
        where: { orderId: id },
        select: shipmentSelect,
      });
      return {
        shipment: unchanged,
        isCreate,
        changed: false,
        prev,
        next,
        token: existing!.trackingToken!,
        orderForEmail: null,
      };
    }

    let token = existing?.trackingToken ?? null;
    let saved;
    if (!existing) {
      token = generateTrackingToken();
      saved = await tx.shipment.create({
        data: {
          orderId: id,
          ...next,
          trackingToken: token,
          trackingTokenCreatedAt: new Date(),
        },
        select: shipmentSelect,
      });
    } else {
      if (isCreate) token = generateTrackingToken();
      saved = await tx.shipment.update({
        where: { orderId: id },
        data: isCreate
          ? { ...data, trackingToken: token, trackingTokenCreatedAt: new Date() }
          : data,
        select: shipmentSelect,
      });
    }

    const changedFields = SHIPMENT_FIELDS.filter(
      (field) => !shipmentFieldValuesEqual(prev[field], next[field]),
    );

    await tx.orderEvent.create({
      data: {
        orderId: id,
        type: 'SHIPMENT_UPDATED',
        message: isCreate
          ? `Shipment details saved${next.trackingNumber ? ` (AWB ${next.trackingNumber})` : ''}`
          : `Shipment details updated${next.trackingNumber ? ` (AWB ${next.trackingNumber})` : ''}`,
        actorId: req.user?.id ?? null,
        actorName: actorName(req),
        metadata: {
          changedFields,
          ...(next.courierName !== null ? { courierName: next.courierName } : {}),
          ...(next.trackingNumber !== null ? { trackingNumber: next.trackingNumber } : {}),
          ...(next.trackingUrl !== null ? { trackingUrl: next.trackingUrl } : {}),
          ...(isCreate ? { trackingTokenIssued: true } : {}),
        },
      },
    });

    // The email is NOT sent inside this transaction: a slow SMTP round-trip
    // must never hold the DB transaction open (Prisma's default 5s interactive
    // timeout would expire mid-send and roll back the shipment). We capture the
    // recipient context here and send AFTER the transaction commits.
    const orderForEmail = await tx.order.findUnique({
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
    });

    return {
      shipment: saved,
      isCreate,
      changed: true,
      prev,
      next,
      token: token!,
      orderForEmail,
    };
  });

  // Automatic customer email, attempted only AFTER the details are committed.
  let emailOutcome: DeliveryOutcome | null = null;
  let emailKind: 'INITIAL' | 'UPDATE' | 'NONE' = 'NONE';

  if (result.changed && result.orderForEmail && result.token) {
    const orderForEmail = result.orderForEmail;
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
      courierName: result.shipment.courierName,
      trackingNumber: result.shipment.trackingNumber,
      trackingUrl: result.shipment.trackingUrl,
      dispatchNotes: result.shipment.dispatchNotes,
      dispatchedAt: result.shipment.dispatchedAt,
      estimatedDeliveryAt: result.shipment.estimatedDeliveryAt,
    };

    const notifications = await import('../shipping/notifications.js');
    if (result.isCreate) {
      emailKind = 'INITIAL';
      emailOutcome = await notifications.sendInitialShipmentEmail(
        id,
        orderInfo,
        shipmentDetails,
        result.token,
      );
    } else {
      emailKind = 'UPDATE';
      const idempotencyKey = `shipment-update:${id}:${shipmentChangeFingerprint(
        result.prev,
        result.next,
      )}`;
      emailOutcome = await notifications.sendUpdateShipmentEmail(
        id,
        shipmentDetails,
        result.token,
        orderInfo,
        null,
        result.shipment.id,
        idempotencyKey,
      );
    }
  }

  // Shipment saving and email delivery are reported separately and truthfully.
  // `sent`/`initialEmailSent` are true ONLY when the provider accepted the
  // message; the saved details are always retained.
  const email = emailOutcome;
  const message = !result.changed
    ? 'No delivery details changed — no customer email was sent.'
    : email?.status === 'SENT'
      ? 'Delivery details saved and the customer email was accepted by the provider.'
      : email?.status === 'ALREADY_SENT'
        ? 'Delivery details saved. This update was already emailed — no duplicate was sent.'
        : email?.status === 'NOT_CONFIGURED'
          ? 'Delivery details saved, but email delivery is not configured on the server.'
          : email?.status === 'NO_RECIPIENT'
            ? 'Delivery details saved, but this order has no customer email address.'
            : 'Delivery details saved, but the customer email could not be sent. You can retry it.';

  res.status(200).json({
    success: true,
    data: {
      shipment: result.shipment,
      changed: result.changed,
      emailKind,
      initialEmailSent: emailKind === 'INITIAL' && email?.status === 'SENT',
      email: email
        ? {
            status: email.status,
            notificationId: email.notificationId,
            sent: email.status === 'SENT',
            error: email.error,
          }
        : {
            status: 'SKIPPED' as const,
            notificationId: null,
            sent: false,
            error: null,
          },
    },
    message,
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

/**
 * Marks an order as delivered (admin-only). This is the explicit customer
 * confirmation action: it stamps `Shipment.deliveredAt` once (creating a
 * shipment record if the admin never saved courier details), advances
 * `fulfillmentStatus` to `DELIVERED` directly for paid/COD orders, records a
 * `DELIVERY_CONFIRMED` event, and sends the delivery-confirmation email after
 * the commit. The email failure never rolls back delivery. Clicking again is
 * idempotent and never sends a duplicate automatic confirmation.
 */
export const markOrderDelivered = asyncHandler(async (req: Request, res: Response) => {
  const id = String(req.params.id ?? '');
  const input = deliverOrderSchema.parse(req.body ?? {});

  const current = await loadOrderForAdmin(id);
  if (current.fulfillmentStatus === 'CANCELLED') {
    throw ApiError.conflict('Cannot mark a cancelled order as delivered');
  }
  // Mirror the shipment gate: only verified payment or COD (CONFIRMED, unpaid)
  // orders may be delivered/confirmed.
  const codConfirmed = current.status === 'CONFIRMED' && current.paymentMethod === 'cod';
  if (current.status !== 'PAID' && !codConfirmed) {
    throw ApiError.conflict('Payment must be verified before marking the order as delivered');
  }

  const deliveredAt = new Date();

  const committed = await prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({
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
        fulfillmentStatus: true,
      },
    });
    if (!order) throw ApiError.notFound('Order not found');

    // If it's already delivered, treat as idempotent (no double event/email).
    if (order.fulfillmentStatus === 'DELIVERED') {
      const existingShipment = await tx.shipment.findUnique({
        where: { orderId: id },
        select: shipmentSelect,
      });
      return {
        alreadyDelivered: true,
        order,
        shipment: existingShipment,
        deliveredAt: existingShipment?.deliveredAt ?? null,
      } as const;
    }

    // A parcel that has been returned to DRAFTOX (or is in the refund flow)
    // can never be newly marked as delivered.
    const activeReturn = await tx.returnRequest.findFirst({
      where: {
        orderId: id,
        status: {
          in: ['ITEM_RECEIVED', 'REFUND_INITIATED', 'REFUND_COMPLETED', 'RESOLVED', 'CLOSED'],
        },
      },
      select: { id: true },
    });
    if (activeReturn) {
      throw ApiError.conflict('This order has an active return and cannot be marked as delivered');
    }

    // Atomically claim the delivery transition. A concurrent duplicate request
    // loses this conditional update and is reported as already delivered, so
    // only one DELIVERY_CONFIRMED event/email can be produced.
    const claim = await tx.order.updateMany({
      where: { id, fulfillmentStatus: { notIn: ['DELIVERED', 'CANCELLED'] } },
      data: { fulfillmentStatus: 'DELIVERED' },
    });
    if (claim.count === 0) {
      const after = await tx.order.findUnique({
        where: { id },
        select: { fulfillmentStatus: true },
      });
      if (after?.fulfillmentStatus === 'DELIVERED') {
        const shipped = await tx.shipment.findUnique({
          where: { orderId: id },
          select: shipmentSelect,
        });
        return {
          alreadyDelivered: true,
          order,
          shipment: shipped,
          deliveredAt: shipped?.deliveredAt ?? null,
        } as const;
      }
      throw ApiError.conflict('Cannot mark a cancelled order as delivered');
    }

    // Stamp deliveredAt once if a shipment exists; otherwise create a minimal
    // shipment record so the delivery confirmation has a real timestamp.
    const existingShipment = await tx.shipment.findUnique({
      where: { orderId: id },
      select: { id: true, deliveredAt: true, trackingToken: true },
    });
    if (existingShipment) {
      if (!existingShipment.deliveredAt) {
        await tx.shipment.update({
          where: { orderId: id },
          data: { deliveredAt },
        });
      }
      if (!existingShipment.trackingToken) {
        await tx.shipment.update({
          where: { orderId: id },
          data: { trackingToken: generateTrackingToken(), trackingTokenCreatedAt: new Date() },
        });
      }
    } else {
      await tx.shipment.create({
        data: {
          orderId: id,
          deliveredAt,
          trackingToken: generateTrackingToken(),
          trackingTokenCreatedAt: new Date(),
        },
      });
    }

    // The conditional update above already advanced fulfilment. The generic map
    // requires SHIPPED/OUT_FOR_DELIVERY, but an admin may confirm delivery from
    // other paid/COD states — we enforce our own guards before this point.

    await tx.orderEvent.create({
      data: {
        orderId: id,
        type: 'DELIVERY_CONFIRMED',
        message: input.note?.trim()
          ? `Marked as delivered — ${input.note.trim()}`
          : 'Marked as delivered',
        actorId: req.user?.id ?? null,
        actorName: actorName(req),
        metadata: {
          deliveredAt: deliveredAt.toISOString(),
          ...(input.note?.trim() ? { note: input.note.trim() } : {}),
        },
      },
    });

    const shipment = await tx.shipment.findUniqueOrThrow({
      where: { orderId: id },
      select: shipmentSelect,
    });
    return { alreadyDelivered: false, order, shipment, deliveredAt } as const;
  });

  // Send confirmation email AFTER commit; failure must not undo delivery.
  let emailOutcome: DeliveryOutcome | null = null;
  if (!committed.alreadyDelivered) {
    const { sendDeliveryConfirmationEmail } = await import('../shipping/notifications.js');
    const orderInfo: OrderInfo = {
      orderNumber: committed.order.orderNumber,
      email: committed.order.email,
      name: committed.order.name,
      address: committed.order.address as OrderInfo['address'],
      items: committed.order.items as OrderInfo['items'],
      amount: committed.order.amount,
      currency: committed.order.currency ?? 'INR',
    };
    const shipmentDetails: ShipmentDetails = {
      courierName: committed.shipment.courierName,
      trackingNumber: committed.shipment.trackingNumber,
      trackingUrl: committed.shipment.trackingUrl,
      dispatchNotes: committed.shipment.dispatchNotes,
      dispatchedAt: committed.shipment.dispatchedAt,
      estimatedDeliveryAt: committed.shipment.estimatedDeliveryAt,
    };
    // Use the stored deliveredAt (set above) as the authoritative timestamp.
    const when = committed.shipment.deliveredAt ?? committed.deliveredAt;
    emailOutcome = await sendDeliveryConfirmationEmail(id, orderInfo, shipmentDetails, when);
  } else {
    // Already delivered — no automatic duplicate confirmation email.
    emailOutcome = null;
  }

  const email = emailOutcome;
  const storedDeliveredAt =
    committed.shipment?.deliveredAt ??
    (committed.deliveredAt instanceof Date ? committed.deliveredAt : null);
  const message = committed.alreadyDelivered
    ? 'Order already marked as delivered.'
    : email?.status === 'SENT'
      ? 'Order marked as delivered and confirmation email accepted by the provider.'
      : email?.status === 'ALREADY_SENT'
        ? 'Order marked as delivered. Confirmation email already sent.'
        : email?.status === 'NOT_CONFIGURED'
          ? 'Order marked as delivered, but email delivery is not configured on the server.'
          : email?.status === 'NO_RECIPIENT'
            ? 'Order marked as delivered, but this order has no customer email address.'
            : 'Order marked as delivered, but the confirmation email could not be sent.';

  res.status(200).json({
    success: true,
    data: {
      orderId: id,
      fulfillmentStatus: 'DELIVERED',
      deliveredAt: storedDeliveredAt ? storedDeliveredAt.toISOString() : null,
      alreadyDelivered: committed.alreadyDelivered,
      shipment: committed.shipment,
      email: email
        ? {
            status: email.status,
            notificationId: email.notificationId,
            sent: email.status === 'SENT',
            error: email.error,
          }
        : {
            status: 'SKIPPED' as const,
            notificationId: null,
            sent: false,
            error: null,
          },
    },
    message,
  });
});

/**
 * Resends the delivery-confirmation email for an already-delivered order.
 * A deliberate admin resend uses a fresh idempotency key so it is never
 * blocked by the automatic "once per order" key; SENT rows are still never
 * duplicated.
 */
export const resendDeliveryConfirmationEmail = asyncHandler(async (req: Request, res: Response) => {
  const id = String(req.params.id ?? '');
  const input = resendDeliveryEmailSchema.parse(req.body ?? {});

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
      fulfillmentStatus: true,
    },
  });
  if (!order) throw ApiError.notFound('Order not found');
  if (order.fulfillmentStatus !== 'DELIVERED') {
    throw ApiError.conflict('This order is not marked as delivered yet');
  }

  const shipment = await prisma.shipment.findUnique({
    where: { orderId: id },
    select: shipmentSelect,
  });
  if (!shipment?.deliveredAt) {
    throw ApiError.conflict('No delivery timestamp is recorded for this order');
  }

  const { sendDeliveryConfirmationEmail } = await import('../shipping/notifications.js');
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
    courierName: shipment.courierName,
    trackingNumber: shipment.trackingNumber,
    trackingUrl: shipment.trackingUrl,
    dispatchNotes: shipment.dispatchNotes,
    dispatchedAt: shipment.dispatchedAt,
    estimatedDeliveryAt: shipment.estimatedDeliveryAt,
  };

  const key = input.idempotencyKey
    ? `delivery-confirmed-resend:${id}:${input.idempotencyKey}`
    : `delivery-confirmed-resend:${id}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
  const outcome = await sendDeliveryConfirmationEmail(
    id,
    orderInfo,
    shipmentDetails,
    shipment.deliveredAt,
    key,
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
        ? 'Delivery confirmation email accepted by the provider.'
        : outcome.status === 'ALREADY_SENT'
          ? 'This confirmation email was already sent.'
          : 'The delivery confirmation email could not be sent.',
  });
});
