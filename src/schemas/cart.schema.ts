import { z } from 'zod';

export const cartLineSchema = z.object({
  slug: z.string().trim().min(1).max(120),
  qty: z.coerce.number().int().min(1).max(10),
});

export const cartSetSchema = z
  .object({
    items: z.array(cartLineSchema).max(20, 'Too many distinct items'),
  })
  .strict();

export type CartSetInput = z.infer<typeof cartSetSchema>;
