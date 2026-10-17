import { z } from 'zod';

export const productListQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).max(1000).default(1),
    limit: z.coerce.number().int().min(1).max(50).default(12),
    search: z.string().trim().min(2).max(100).optional(),
  })
  .strict();

export type ProductListQuery = z.infer<typeof productListQuerySchema>;
