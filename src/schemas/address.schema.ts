import { z } from 'zod';

export const addressSchema = z
  .object({
    label: z.string().trim().min(1).max(60),
    line: z.string().trim().min(5).max(200),
    city: z.string().trim().min(2).max(80),
    state: z.string().trim().min(2).max(80),
    pincode: z.string().trim().regex(/^\d{6}$/, 'PIN code must be 6 digits'),
  })
  .strict();

export type AddressInput = z.infer<typeof addressSchema>;
