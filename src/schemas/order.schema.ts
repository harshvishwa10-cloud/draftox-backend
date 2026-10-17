import { z } from 'zod';
import { emailSchema, nameSchema } from './auth.schema.js';

const phoneSchema = z
  .string()
  .trim()
  .regex(/^[+0-9()\-\s]{5,20}$/, 'Enter a valid phone number')
  .optional();

export const orderItemSchema = z.object({
  productId: z.string().trim().min(1, 'Product is required').max(100),
  qty: z.coerce.number().int().min(1).max(10),
});

export const createOrderSchema = z
  .object({
    items: z.array(orderItemSchema).min(1, 'Add at least one item').max(20),
    name: nameSchema,
    email: emailSchema,
    phone: phoneSchema,
    address: z
      .object({
        line: z.string().trim().min(5).max(200),
        city: z.string().trim().min(2).max(80),
        state: z.string().trim().min(2).max(80),
        pincode: z.string().trim().regex(/^\d{6}$/, 'PIN code must be 6 digits'),
      })
      .optional(),
    /**
     * Requested payment mode. `cod` creates a CONFIRMED, pay-on-delivery order;
     * `online` (or omitted, the historical default) files a REQUESTED order that
     * is only marked paid after a verified Razorpay payment.
     */
    paymentMethod: z.enum(['cod', 'online']).optional(),
    /**
     * Optional client idempotency key. A retried checkout with the same key
     * returns the original order rather than creating a duplicate.
     */
    idempotencyKey: z.string().trim().min(8).max(120).optional(),
  })
  .strict();

export type CreateOrderInput = z.infer<typeof createOrderSchema>;
