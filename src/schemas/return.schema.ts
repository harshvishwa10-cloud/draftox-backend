import { z } from 'zod';

export const returnReasonSchema = z.enum([
  'DEFECTIVE',
  'NOT_AS_DESCRIBED',
  'DAMAGED_IN_TRANSIT',
  'WRONG_ITEM',
  'OTHER',
]);

/**
 * Authored photo sent with a return request, base64-encoded inside the JSON
 * body. The server re-validates magic bytes, declared size and per-file limits;
 * the client never controls where or how files are stored.
 */
const returnPhotoSchema = z
  .object({
    name: z.string().trim().min(1, 'File name is required').max(120),
    type: z.string().trim().min(1, 'File type is required').max(60),
    size: z.number().int().gte(1),
    dataBase64: z.string().min(1, 'File data is required'),
  })
  .strict();

export const createReturnSchema = z
  .object({
    reason: returnReasonSchema,
    explanation: z
      .string()
      .trim()
      .min(10, 'Please describe the issue in a few words (at least 10 characters)')
      .max(2000),
    photos: z.array(returnPhotoSchema).min(1, 'Add at least one photo').max(5, 'You can attach up to 5 photos'),
  })
  .strict();

/** Admin decision actions (validate against the state machine in code). */
export const decideReturnSchema = z
  .object({
    action: z.enum(['APPROVE', 'REJECT', 'RECEIVED', 'RESOLVE']),
    note: z.string().trim().max(1000).optional(),
  })
  .strict();

export const adminReturnListQuerySchema = z.object({
  status: z
    .enum([
      'SUBMITTED',
      'APPROVED',
      'REJECTED',
      'ITEM_RECEIVED',
      'REFUND_INITIATED',
      'REFUND_COMPLETED',
      'RESOLVED',
      'CLOSED',
    ])
    .optional(),
  q: z.string().trim().max(120).optional(),
});

export type CreateReturnInput = z.infer<typeof createReturnSchema>;
export type DecideReturnInput = z.infer<typeof decideReturnSchema>;