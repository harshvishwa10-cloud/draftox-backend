import { z } from 'zod';

const paymentStatusSchema = z.enum(['REQUESTED', 'CONFIRMED', 'PAID', 'FAILED', 'CANCELLED']);

const fulfillmentStatusSchema = z.enum([
  'AWAITING_PAYMENT',
  'PROCESSING',
  'READY_TO_SHIP',
  'SHIPPED',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'CANCELLED',
]);

/** Filters + pagination for the admin order list. Unknown keys are stripped. */
export const adminOrderListQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  paymentStatus: paymentStatusSchema.optional(),
  fulfillmentStatus: fulfillmentStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().trim().min(1).max(100).optional(),
});

export const updateFulfillmentSchema = z
  .object({
    status: fulfillmentStatusSchema,
    note: z.string().trim().max(500).optional(),
  })
  .strict();

const nullableTrimmed = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();

/** Accepts an ISO datetime, empty string, or null; empty → null. */
const nullableDate = z
  .union([z.literal(''), z.null(), z.coerce.date()])
  .transform((v) => (v === '' ? null : v))
  .refine(
    (v) => v === null || v === undefined || (v instanceof Date && !Number.isNaN(v.getTime())),
    { message: 'Enter a valid date' },
  )
  .refine(
    (v) =>
      v === null ||
      v === undefined ||
      (v.getUTCFullYear() >= 2000 && v.getUTCFullYear() <= 2100),
    { message: 'Date must be between 2000 and 2100' },
  )
  .optional();

/**
 * Tracking links are opened directly in the customer's browser, so only
 * absolute HTTP(S) URLs are accepted. `javascript:`, `data:`, protocol-relative
 * and relative values are rejected on the server, independently of the UI.
 */
const safeTrackingUrlSchema = z
  .union([z.string().trim().max(500), z.literal(''), z.null()])
  .transform((v) => (v === '' || v === null ? null : v))
  .refine(
    (value) => {
      if (value === null || value === undefined) return true;
      try {
        const url = new URL(value);
        return (url.protocol === 'http:' || url.protocol === 'https:') && Boolean(url.hostname);
      } catch {
        return false;
      }
    },
    { message: 'Enter a valid http(s) tracking URL' },
  )
  .optional();

export const upsertShipmentSchema = z
  .object({
    courierName: nullableTrimmed(80),
    trackingNumber: nullableTrimmed(64),
    trackingUrl: safeTrackingUrlSchema,
    dispatchNotes: nullableTrimmed(1000),
    dispatchedAt: nullableDate,
    estimatedDeliveryAt: nullableDate,
  })
  .strict();

/** Optional admin note recorded with the delivery confirmation. */
export const deliverOrderSchema = z
  .object({
    note: z.string().trim().max(500).optional(),
  })
  .strict();

/** Optional client idempotency key for a deliberate confirmation resend. */
export const resendDeliveryEmailSchema = z
  .object({
    idempotencyKey: z.string().trim().min(8).max(120).optional(),
  })
  .strict();

export type AdminOrderListQuery = z.infer<typeof adminOrderListQuerySchema>;
export type UpdateFulfillmentInput = z.infer<typeof updateFulfillmentSchema>;
export type UpsertShipmentInput = z.infer<typeof upsertShipmentSchema>;
export type DeliverOrderInput = z.infer<typeof deliverOrderSchema>;
