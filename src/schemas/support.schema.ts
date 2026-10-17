import { z } from 'zod';
import { emailSchema, nameSchema } from './auth.schema.js';

export const supportSchema = z
  .object({
    name: nameSchema,
    contact: z
      .string()
      .trim()
      .min(3, 'Provide an email or phone number')
      .max(254)
      .refine((v) => emailSchema.safeParse(v).success || /^[+0-9()\-\s]{5,20}$/.test(v), {
        message: 'Provide a valid email or phone number',
      }),
    subject: z
      .string()
      .trim()
      .min(3, 'Subject must be at least 3 characters')
      .max(200, 'Subject must be at most 200 characters'),
    message: z
      .string()
      .trim()
      .min(10, 'Message must be at least 10 characters')
      .max(5000, 'Message must be at most 5000 characters'),
  })
  .strict();

export type SupportInput = z.infer<typeof supportSchema>;
