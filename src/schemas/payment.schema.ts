import { z } from 'zod';

/** Body for POST /api/v1/payments/razorpay/order. */
export const createRazorpayOrderSchema = z
  .object({
    orderId: z.string().trim().min(1, 'orderId is required').max(100),
  })
  .strict();

/**
 * Body for POST /api/v1/payments/razorpay/verify — the values returned to the
 * browser by Razorpay Checkout after a successful payment.
 */
export const verifyPaymentSchema = z
  .object({
    orderId: z.string().trim().min(1, 'orderId is required').max(100),
    razorpayOrderId: z.string().trim().min(1, 'razorpayOrderId is required').max(100),
    razorpayPaymentId: z.string().trim().min(1, 'razorpayPaymentId is required').max(100),
    razorpaySignature: z.string().trim().min(1, 'razorpaySignature is required').max(512),
  })
  .strict();

export type CreateRazorpayOrderInput = z.infer<typeof createRazorpayOrderSchema>;
export type VerifyPaymentInput = z.infer<typeof verifyPaymentSchema>;
