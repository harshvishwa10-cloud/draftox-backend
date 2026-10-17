import { z } from 'zod';
import { emailSchema, nameSchema } from './auth.schema.js';

export const productInquirySchema = z
  .object({
    productId: z.string().trim().min(1, 'Product is required').max(100),
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
  .strict();

export type ProductInquiryInput = z.infer<typeof productInquirySchema>;
