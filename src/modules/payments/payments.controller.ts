import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import {
  env,
  razorpayConfigured,
  razorpayWebhookConfigured,
  storeOrdersEnabled,
} from '../../config/env.js';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { ApiError } from '../../utils/ApiError.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { createRazorpayOrderSchema, verifyPaymentSchema } from '../../schemas/payment.schema.js';
import {
  parseWebhookEvent,
  razorpayAuthHeader,
  toPaise,
  verifyPaymentSignature,
  verifyWebhookSignature,
  type ParsedWebhookEvent,
  type RazorpayWebhookEvent,
} from './razorpay.js';
import { markOrderPaid } from './orderPayment.js';
import { recordPaymentException } from './exceptions.js';

const RAZORPAY_API = 'https://api.razorpay.com/v1';

const orderSelect = {
  id: true,
  orderNumber: true,
  items: true,
  subtotal: true,
  amount: true,
  currency: true,
  status: true,
  paymentMethod: true,
  createdAt: true,
  updatedAt: true,
} as const;

function requireRazorpay() {
  if (!razorpayConfigured) {
    throw ApiError.serviceUnavailable(
      'Online payments are not configured on this server yet. Complete your order request and pay after the team confirms it.',
    );
  }
}

export const paymentStatus = asyncHandler(async (_req: Request, res: Response) => {
  res.status(200).json({
    success: true,
    data: { razorpay: razorpayConfigured, webhook: razorpayWebhookConfigured },
  });
});

interface ProviderPayment {
  id?: string;
  order_id?: string;
  amount?: number;
  currency?: string;
  status?: string;
  method?: string;
}

/** Server-to-server lookup used to confirm amount/currency/status. */
async function fetchRazorpayPayment(paymentId: string): Promise<ProviderPayment | null> {
  try {
    const response = await fetch(`${RAZORPAY_API}/payments/${encodeURIComponent(paymentId)}`, {
      headers: { Authorization: razorpayAuthHeader() },
    });
    if (!response.ok) return null;
    return (await response.json()) as ProviderPayment;
  } catch {
    return null;
  }
}

interface WebhookProcessResult {
  handled: boolean;
  outcome: 'PROCESSED' | 'IGNORED';
  reason?: string;
}

/** Decimal rupees for display/logging; rounded to 2 dp. */
function paiseToRupees(paise: number | undefined): number | null {
  return typeof paise === 'number' && Number.isFinite(paise) ? Math.round(paise) / 100 : null;
}

/**
 * Applies one normalised Razorpay webhook event to local state. Pure of HTTP
 * concerns so it can run after the event is durably recorded. Anything it cannot
 * safely apply becomes a PaymentException for the admin queue rather than a
 * silent drop.
 *
 * - ignored/unhandled event             → IGNORED (no money effect)
 * - payment for an unknown local order  → UNMATCHED_PAYMENT exception
 * - amount/currency that does not match → AMOUNT_/CURRENCY_MISMATCH exception
 * - captured payment on a CANCELLED order → CANCELLED_PAYMENT exception
 * - second payment for an already-PAID order → DUPLICATE_PAYMENT exception
 * - otherwise                           → idempotent PAID transition
 */
async function processWebhookEvent(
  parsed: ParsedWebhookEvent,
  webhookEventId: string,
): Promise<WebhookProcessResult> {
  if (parsed.action === 'ignored' || !parsed.razorpayOrderId) {
    return { handled: false, outcome: 'IGNORED', reason: 'unhandled_event' };
  }

  const order = await prisma.order.findUnique({
    where: { razorpayOrderId: parsed.razorpayOrderId },
  });
  if (!order) {
    await recordPaymentException({
      kind: 'UNMATCHED_PAYMENT',
      razorpayOrderId: parsed.razorpayOrderId,
      razorpayPaymentId: parsed.razorpayPaymentId ?? null,
      amount: paiseToRupees(parsed.amountPaise),
      currency: parsed.currency ?? null,
      reason: 'A verified payment arrived for a Razorpay order with no matching local order.',
      webhookEventId,
      details: { source: 'webhook' },
    });
    return { handled: false, outcome: 'IGNORED', reason: 'unmatched_payment' };
  }

  if (parsed.action === 'paid') {
    const expectedPaise = toPaise(order.amount.toString());
    const amountOk = typeof parsed.amountPaise === 'number' ? parsed.amountPaise === expectedPaise : true;
    const currencyOk = parsed.currency ? parsed.currency === order.currency : true;
    if (!amountOk) {
      await recordPaymentException({
        kind: 'AMOUNT_MISMATCH',
        orderId: order.id,
        razorpayOrderId: parsed.razorpayOrderId,
        razorpayPaymentId: parsed.razorpayPaymentId ?? null,
        amount: order.amount,
        currency: order.currency,
        reason: 'A verified payment amount does not match the order amount.',
        webhookEventId,
        details: { expectedPaise, receivedPaise: parsed.amountPaise ?? null },
      });
      return { handled: false, outcome: 'IGNORED', reason: 'amount_mismatch' };
    }
    if (!currencyOk) {
      await recordPaymentException({
        kind: 'CURRENCY_MISMATCH',
        orderId: order.id,
        razorpayOrderId: parsed.razorpayOrderId,
        razorpayPaymentId: parsed.razorpayPaymentId ?? null,
        amount: order.amount,
        currency: order.currency,
        reason: 'A verified payment currency does not match the order currency.',
        webhookEventId,
        details: { expected: order.currency, received: parsed.currency ?? null },
      });
      return { handled: false, outcome: 'IGNORED', reason: 'currency_mismatch' };
    }
    if (order.status === 'CANCELLED') {
      await recordPaymentException({
        kind: 'CANCELLED_PAYMENT',
        orderId: order.id,
        razorpayOrderId: parsed.razorpayOrderId,
        razorpayPaymentId: parsed.razorpayPaymentId ?? null,
        amount: order.amount,
        currency: order.currency,
        reason: 'A verified payment was captured for an order that is cancelled. A refund is required.',
        webhookEventId,
        details: { source: 'webhook' },
      });
      return { handled: false, outcome: 'IGNORED', reason: 'cancelled' };
    }
    if (order.status === 'PAID') {
      if (
        parsed.razorpayPaymentId &&
        order.razorpayPaymentId &&
        parsed.razorpayPaymentId !== order.razorpayPaymentId
      ) {
        await recordPaymentException({
          kind: 'DUPLICATE_PAYMENT',
          orderId: order.id,
          razorpayOrderId: parsed.razorpayOrderId,
          razorpayPaymentId: parsed.razorpayPaymentId,
          amount: order.amount,
          currency: order.currency,
          reason: 'A second payment was captured for an order that is already paid.',
          webhookEventId,
          details: { existingPaymentId: order.razorpayPaymentId, source: 'webhook' },
        });
        return { handled: false, outcome: 'IGNORED', reason: 'duplicate_payment' };
      }
      return { handled: true, outcome: 'PROCESSED' };
    }

    const outcome = await markOrderPaid(order.id, parsed.razorpayPaymentId, parsed.method);
    if (outcome === 'duplicate_payment') {
      await recordPaymentException({
        kind: 'DUPLICATE_PAYMENT',
        orderId: order.id,
        razorpayOrderId: parsed.razorpayOrderId,
        razorpayPaymentId: parsed.razorpayPaymentId ?? null,
        amount: order.amount,
        currency: order.currency,
        reason: 'This payment id is already recorded on a different order.',
        webhookEventId,
        details: { source: 'webhook' },
      });
      return { handled: false, outcome: 'IGNORED', reason: 'duplicate_payment' };
    }
    return { handled: true, outcome: 'PROCESSED' };
  }

  // parsed.action === 'failed'
  if (order.status === 'REQUESTED' || order.status === 'CONFIRMED') {
    const failed = await prisma.order.updateMany({
      where: { id: order.id, status: { in: ['REQUESTED', 'CONFIRMED'] } },
      data: { status: 'FAILED' },
    });
    if (failed.count > 0) {
      await prisma.orderEvent
        .create({
          data: {
            orderId: order.id,
            type: 'PAYMENT_FAILED',
            message: 'Payment failed',
            metadata: {
              ...(parsed.razorpayPaymentId ? { razorpayPaymentId: parsed.razorpayPaymentId } : {}),
            },
          },
        })
        .catch(() => undefined);
    }
  }
  return { handled: true, outcome: 'PROCESSED' };
}

/** Stable dedup key for a webhook without an event-id header (SHA-256 of the raw body). */
function bodyEventId(raw: Buffer): string {
  return `body_${createHash('sha256').update(raw).digest('hex')}`;
}

/**
 * Creates (or reuses) a Razorpay order for an authenticated user's own pending
 * order. The payable amount is always derived from the server-side order record
 * — never from the request body.
 */
export const createRazorpayOrder = asyncHandler(async (req: Request, res: Response) => {
  // No new money while the store is closed. Existing paid/completed orders are
  // unaffected, and the webhook keeps working so already-made payments settle.
  if (!storeOrdersEnabled) {
    throw ApiError.ordersDisabled(
      'Orders are paused while DRAFTOX prepares for launch. No online payment is being collected right now.',
    );
  }
  requireRazorpay();
  if (!req.user) throw ApiError.unauthorized();
  const input = createRazorpayOrderSchema.parse(req.body);

  // Ownership: a user may only pay for their own order.
  const order = await prisma.order.findFirst({
    where: { id: input.orderId, userId: req.user.id },
  });
  if (!order) throw ApiError.notFound('Order not found');
  if (order.status === 'PAID') throw ApiError.conflict('This order is already paid');
  if (order.status === 'CANCELLED') throw ApiError.badRequest('This order was cancelled');
  if (order.status !== 'REQUESTED' && order.status !== 'CONFIRMED') {
    throw ApiError.badRequest(`Order cannot be paid in status ${order.status}`);
  }

  const amountPaise = toPaise(order.amount.toString());
  if (!Number.isFinite(amountPaise) || amountPaise < 100) {
    throw ApiError.badRequest('Order amount is invalid');
  }

  // Retries reuse the existing Razorpay order — never create duplicates.
  if (order.razorpayOrderId) {
    res.status(200).json({
      success: true,
      data: {
        keyId: env.RAZORPAY_KEY_ID,
        razorpayOrderId: order.razorpayOrderId,
        amount: amountPaise,
        currency: order.currency,
        orderId: order.id,
      },
    });
    return;
  }

  let created: { id?: string };
  try {
    const response = await fetch(`${RAZORPAY_API}/orders`, {
      method: 'POST',
      headers: {
        Authorization: razorpayAuthHeader(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount: amountPaise,
        currency: order.currency,
        receipt: order.id,
        notes: { store_order_id: order.id },
      }),
    });
    if (!response.ok) {
      throw ApiError.serviceUnavailable('Payment provider did not create the order. Please try again.');
    }
    created = (await response.json()) as { id?: string };
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw ApiError.serviceUnavailable('Could not reach the payment provider. Please try again.');
  }
  if (!created.id) throw ApiError.serviceUnavailable('Payment provider returned an invalid response.');

  await prisma.order.update({
    where: { id: order.id },
    data: { razorpayOrderId: created.id },
  });

  res.status(201).json({
    success: true,
    data: {
      keyId: env.RAZORPAY_KEY_ID,
      razorpayOrderId: created.id,
      amount: amountPaise,
      currency: order.currency,
      orderId: order.id,
    },
  });
});

/**
 * Verifies the payment signature returned by Razorpay Checkout, then confirms
 * the amount/currency/order association server-to-server before marking PAID.
 * The browser callback alone is never trusted.
 */
export const verifyRazorpayPayment = asyncHandler(async (req: Request, res: Response) => {
  requireRazorpay();
  if (!req.user) throw ApiError.unauthorized();
  if (!env.RAZORPAY_KEY_SECRET) throw ApiError.serviceUnavailable('Online payments are not configured');
  const input = verifyPaymentSchema.parse(req.body);

  const order = await prisma.order.findFirst({
    where: { id: input.orderId, userId: req.user.id },
    select: { ...orderSelect, razorpayOrderId: true, razorpayPaymentId: true, userId: true },
  });
  if (!order) throw ApiError.notFound('Order not found');
  if (order.status === 'CANCELLED') throw ApiError.conflict('This order was cancelled');

  if (!order.razorpayOrderId || order.razorpayOrderId !== input.razorpayOrderId) {
    throw ApiError.badRequest('This payment does not belong to this order');
  }

  if (order.status === 'PAID') {
    res.status(200).json({ success: true, data: { order, status: 'PAID', alreadyPaid: true } });
    return;
  }

  const signatureOk = verifyPaymentSignature({
    razorpayOrderId: input.razorpayOrderId,
    razorpayPaymentId: input.razorpayPaymentId,
    signature: input.razorpaySignature,
    keySecret: env.RAZORPAY_KEY_SECRET,
  });
  if (!signatureOk) throw ApiError.badRequest('Payment signature verification failed');

  // Confirm with Razorpay that the payment is captured and matches this order.
  const payment = await fetchRazorpayPayment(input.razorpayPaymentId);
  if (!payment) {
    throw ApiError.serviceUnavailable(
      'The payment could not be confirmed with the provider yet. Your order stays pending and will update automatically once confirmed.',
    );
  }
  if (payment.order_id && payment.order_id !== order.razorpayOrderId) {
    throw ApiError.badRequest('Payment is linked to a different order');
  }
  if (payment.currency && payment.currency !== order.currency) {
    throw ApiError.badRequest('Payment currency does not match the order');
  }
  const expectedPaise = toPaise(order.amount.toString());
  if (typeof payment.amount === 'number' && payment.amount !== expectedPaise) {
    throw ApiError.badRequest('Payment amount does not match the order');
  }
  if (payment.status && payment.status !== 'captured' && payment.status !== 'authorized') {
    throw ApiError.badRequest(`Payment is not captured yet (status ${payment.status})`);
  }

  const outcome = await markOrderPaid(order.id, input.razorpayPaymentId, payment.method);
  if (outcome === 'duplicate_payment') {
    // A verified payment that belongs to a different order must never be applied.
    throw ApiError.conflict('This payment id is already recorded on a different order');
  }
  const updated = await prisma.order.findUnique({ where: { id: order.id }, select: orderSelect });
  res.status(200).json({ success: true, data: { order: updated, status: 'PAID' } });
});

/**
 * Razorpay webhook. Verifies the HMAC signature over the RAW body, then records
 * the event durably BEFORE processing (deduplicated on Razorpay's
 * `x-razorpay-event-id`, or a hash of the body when absent) so an accepted event
 * is never silently lost and retries are idempotent. Events we cannot safely
 * apply are recorded as PaymentExceptions for the admin queue.
 *
 * A processing error returns 500 so Razorpay retries; a duplicate of an already
 * PROCESSED/IGNORED event is acknowledged. An order is only ever marked PAID
 * here, in the verified verify endpoint, or by reconciliation.
 */
export async function razorpayWebhook(req: Request, res: Response): Promise<void> {
  if (!razorpayWebhookConfigured || !env.RAZORPAY_WEBHOOK_SECRET) {
    res.status(503).json({
      success: false,
      error: { code: 'SERVICE_UNAVAILABLE', message: 'Payment webhooks are not configured' },
    });
    return;
  }

  const signature = req.get('x-razorpay-signature') ?? '';
  const raw = req.body as Buffer;
  if (!Buffer.isBuffer(raw) || !verifyWebhookSignature(raw, signature, env.RAZORPAY_WEBHOOK_SECRET)) {
    // Never log the signature or body — only that a bad one arrived.
    logger.warn('razorpay_webhook_invalid_signature', { ip: req.ip });
    res.status(400).json({
      success: false,
      error: { code: 'BAD_REQUEST', message: 'Invalid webhook signature' },
    });
    return;
  }

  let event: RazorpayWebhookEvent;
  try {
    event = JSON.parse(raw.toString('utf8')) as RazorpayWebhookEvent;
  } catch {
    res.status(400).json({
      success: false,
      error: { code: 'BAD_REQUEST', message: 'Invalid webhook payload' },
    });
    return;
  }

  const parsed = parseWebhookEvent(event);
  const headerEventId = (req.get('x-razorpay-event-id') ?? '').trim();
  const eventId = headerEventId || bodyEventId(raw);

  // Ensure a durable record exists before touching order state. A prior
  // PROCESSED/IGNORED row means this exact event was already handled.
  let record = await prisma.webhookEvent.findUnique({ where: { eventId } });
  if (record && (record.status === 'PROCESSED' || record.status === 'IGNORED')) {
    res.status(200).json({
      success: true,
      data: { received: true, handled: record.status === 'PROCESSED', duplicate: true },
    });
    return;
  }
  if (!record) {
    try {
      record = await prisma.webhookEvent.create({
        data: {
          eventId,
          eventType: event.event ?? null,
          status: 'RECEIVED',
          razorpayOrderId: parsed.razorpayOrderId ?? null,
          razorpayPaymentId: parsed.razorpayPaymentId ?? null,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        // A concurrent delivery created it first.
        record = await prisma.webhookEvent.findUnique({ where: { eventId } });
      } else {
        throw err;
      }
    }
  }
  if (!record) {
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Webhook event could not be recorded' },
    });
    return;
  }

  try {
    const result = await processWebhookEvent(parsed, record.id);
    await prisma.webhookEvent.update({
      where: { id: record.id },
      data: {
        status: result.outcome,
        attempts: { increment: 1 },
        processedAt: new Date(),
        error: null,
      },
    });
    res.status(200).json({
      success: true,
      data: {
        received: true,
        handled: result.handled,
        ...(result.reason ? { reason: result.reason } : {}),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.webhookEvent
      .update({
        where: { id: record.id },
        data: { status: 'FAILED', attempts: { increment: 1 }, error: message.slice(0, 300) },
      })
      .catch(() => undefined);
    await recordPaymentException({
      kind: 'WEBHOOK_FAILED',
      razorpayOrderId: parsed.razorpayOrderId ?? null,
      razorpayPaymentId: parsed.razorpayPaymentId ?? null,
      reason: 'A verified webhook failed to process and will be retried by the provider.',
      webhookEventId: record.id,
      details: { eventType: event.event ?? null },
    });
    logger.error('razorpay_webhook_processing_failed', { eventId, error: message });
    // 500 so Razorpay retries; the FAILED row lets us reprocess on the next try.
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Webhook processing failed' },
    });
  }
}
