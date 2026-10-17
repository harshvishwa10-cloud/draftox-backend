import { z } from 'zod';
import { emailSchema, nameSchema } from './auth.schema.js';

export const contactSchema = z
  .object({
    name: nameSchema,
    email: emailSchema,
    businessName: z.string().trim().max(150).optional(),
    service: z.enum([
      'WEBSITE_DEVELOPMENT',
      'LOGO_BRAND_IDENTITY',
      'DIGITAL_PRODUCT',
      'HOME_AUTOMATION',
      'OTHER',
    ]),
    budgetRange: z
      .enum([
        'NOT_SURE',
        'UNDER_10000',
        'FROM_10000_TO_25000',
        'FROM_25000_TO_50000',
        'FROM_50000_TO_100000',
        'ABOVE_100000',
      ])
      .optional(),
    message: z
      .string()
      .trim()
      .min(10, 'Message must be at least 10 characters')
      .max(5000, 'Message must be at most 5000 characters'),
  })
  .strict();

export type ContactInput = z.infer<typeof contactSchema>;
