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
  .optional();

export const upsertShipmentSchema = z
  .object({
    courierName: nullableTrimmed(80),
    trackingNumber: nullableTrimmed(64),
    trackingUrl: z
      .union([z.string().trim().url('Enter a valid tracking URL').max(500), z.literal(''), z.null()])
      .transform((v) => (v === '' ? null : v))
      .optional(),
    dispatchNotes: nullableTrimmed(1000),
    dispatchedAt: nullableDate,
    estimatedDeliveryAt: nullableDate,
  })
  .strict();

export type AdminOrderListQuery = z.infer<typeof adminOrderListQuerySchema>;
export type UpdateFulfillmentInput = z.infer<typeof updateFulfillmentSchema>;
export type UpsertShipmentInput = z.infer<typeof upsertShipmentSchema>;
