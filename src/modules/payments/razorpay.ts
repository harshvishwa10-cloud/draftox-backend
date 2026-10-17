import { createHmac } from 'node:crypto';
import { safeEqual } from '../../utils/cookies.js';
import { env } from '../../config/env.js';

/**
 * Pure, side-effect-free Razorpay helpers. Kept separate from the controller so
 * signature/amount logic can be unit tested without network or credentials.
 */

/** Basic-auth header for Razorpay API calls (uses only configured credentials). */
export function razorpayAuthHeader(): string {
  return `Basic ${Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString('base64')}`;
}

/** Razorpay amounts are integer paise. Returns NaN for non-numeric input. */
export function toPaise(amount: number | string): number {
  const n = Number(amount);
  if (!Number.isFinite(n)) return Number.NaN;
  return Math.round(n * 100);
}

/**
 * HMAC-SHA256 (hex) of `${razorpayOrderId}|${razorpayPaymentId}` using the
 * Razorpay Key Secret. This is the signature Razorpay returns in Checkout.
 */
export function buildPaymentSignature(
  razorpayOrderId: string,
  razorpayPaymentId: string,
  keySecret: string,
): string {
  return createHmac('sha256', keySecret)
    .update(`${razorpayOrderId}|${razorpayPaymentId}`)
    .digest('hex');
}

/** Timing-safe check of a Checkout payment signature. Never throws. */
export function verifyPaymentSignature(input: {
  razorpayOrderId: string;
  razorpayPaymentId: string;
  signature: string;
  keySecret: string;
}): boolean {
  if (!input.razorpayOrderId || !input.razorpayPaymentId || !input.signature || !input.keySecret) {
    return false;
  }
  const expected = buildPaymentSignature(
    input.razorpayOrderId,
    input.razorpayPaymentId,
    input.keySecret,
  );
  return safeEqual(expected, input.signature);
}

/** HMAC-SHA256 (hex) of the RAW webhook request body using the Webhook Secret. */
export function buildWebhookSignature(rawBody: Buffer | string, webhookSecret: string): string {
  return createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
}

/** Timing-safe check of the `x-razorpay-signature` header. Never throws. */
export function verifyWebhookSignature(
  rawBody: Buffer | string,
  signature: string,
  webhookSecret: string,
): boolean {
  if (!signature || !webhookSecret) return false;
  return safeEqual(buildWebhookSignature(rawBody, webhookSecret), signature);
}

export interface RazorpayPaymentEntity {
  id?: string;
  order_id?: string;
  amount?: number;
  currency?: string;
  status?: string;
  /** Payment instrument reported by the provider, e.g. "upi", "card", "netbanking". */
  method?: string;
}

export interface RazorpayOrderEntity {
  id?: string;
  amount?: number;
  currency?: string;
  receipt?: string;
  notes?: Record<string, unknown>;
}

export interface RazorpayWebhookEvent {
  event?: string;
  payload?: {
    payment?: { entity?: RazorpayPaymentEntity };
    order?: { entity?: RazorpayOrderEntity };
  };
}

export interface ParsedWebhookEvent {
  action: 'paid' | 'failed' | 'ignored';
  /** The Razorpay order id, used to find the local order. */
  razorpayOrderId?: string;
  razorpayPaymentId?: string;
  amountPaise?: number;
  currency?: string;
  method?: string;
}

/**
 * Normalises the Razorpay event payloads we act on. Anything else is ignored.
 * `order.paid` uses the order entity id (which is the id we stored) and has no
 * payment id, so it is handled by the amount/currency checks alone.
 */
export function parseWebhookEvent(event: RazorpayWebhookEvent): ParsedWebhookEvent {
  const payment = event.payload?.payment?.entity;
  const rzpOrder = event.payload?.order?.entity;

  switch (event.event) {
    case 'payment.captured':
      return {
        action: 'paid',
        razorpayOrderId: payment?.order_id,
        razorpayPaymentId: payment?.id,
        amountPaise: payment?.amount,
        currency: payment?.currency,
        method: payment?.method,
      };
    case 'payment.failed':
      return {
        action: 'failed',
        razorpayOrderId: payment?.order_id,
        razorpayPaymentId: payment?.id,
        amountPaise: payment?.amount,
        currency: payment?.currency,
        method: payment?.method,
      };
    case 'order.paid':
      return {
        action: 'paid',
        razorpayOrderId: rzpOrder?.id,
        amountPaise: rzpOrder?.amount,
        currency: rzpOrder?.currency,
      };
    default:
      return { action: 'ignored' };
  }
}
