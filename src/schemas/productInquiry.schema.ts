import { z } from 'zod';
import { emailSchema, nameSchema } from './auth.schema.js';

export const productInquirySchema = z
  .object({
    /** Backend catalogue id. Optional so the storefront can inquire by slug. */
    productId: z.string().trim().min(1).max(100).optional(),
    /** Stable catalogue slug — avoids a catalogue fetch before submitting. */
    productSlug: z.string().trim().min(1).max(120).optional(),
    customerName: nameSchema,
    email: emailSchema,
    phone: z
      .string()
      .trim()
      .regex(/^[+0-9()\-\s]{5,20}$/, 'Enter a valid phone number')
      .optional(),
    quantity: z.coerce.number().int().min(1).max(1000).optional(),
    type: z
      .enum(['PURCHASE_INTENT', 'QUESTION', 'DEMO_REQUEST', 'CUSTOM_ORDER', 'OTHER'])
      .default('PURCHASE_INTENT'),
    message: z
      .string()
      .trim()
      .min(10, 'Message must be at least 10 characters')
      .max(5000, 'Message must be at most 5000 characters'),
  })
  .strict()
  .refine((input) => Boolean(input.productId || input.productSlug), {
    message: 'Product is required',
    path: ['productId'],
  });

export type ProductInquiryInput = z.infer<typeof productInquirySchema>;
