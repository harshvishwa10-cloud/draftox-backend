import { z } from 'zod';

export const emailSchema = z
  .string()
  .trim()
  .min(3, 'Email is required')
  .max(254, 'Email is too long')
  .email('Enter a valid email address')
  .transform((v) => v.toLowerCase());

export const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(72, 'Password must be at most 72 characters');

export const nameSchema = z
  .string()
  .trim()
  .min(2, 'Name must be at least 2 characters')
  .max(100, 'Name must be at most 100 characters');

export const registerSchema = z
  .object({
    name: nameSchema,
    email: emailSchema,
    password: passwordSchema,
  })
  .strict();

export const loginSchema = z
  .object({
    email: z.string().trim().min(3).max(254).email('Enter a valid email address').transform((v) => v.toLowerCase()),
    password: z.string().min(1, 'Password is required').max(72),
  })
  .strict();

export const forgotPasswordSchema = z
  .object({
    email: emailSchema,
  })
  .strict();

export const resetPasswordSchema = z
  .object({
    token: z.string().trim().min(20, 'Invalid reset token').max(200),
    password: passwordSchema,
  })
  .strict();

/**
 * Exchanges a client-obtained Firebase ID token for a server-managed session
 * cookie. The token is re-verified server-side; nothing else is trusted.
 */
export const firebaseSessionSchema = z
  .object({
    idToken: z
      .string()
      .trim()
      .min(20, 'A Firebase ID token is required')
      .max(8192, 'Firebase ID token is too long'),
  })
  .strict();

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
