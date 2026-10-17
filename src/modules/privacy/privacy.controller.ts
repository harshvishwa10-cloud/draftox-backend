import type { Request, Response } from 'express';
import { prisma } from '../../lib/prisma.js';
import { ApiError } from '../../utils/ApiError.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { privacyPreferencesSchema } from './privacy.schema.js';

const select = {
  marketingEmail: true,
  updatedAt: true,
} as const;

interface PreferencesPayload {
  marketingEmail: boolean;
  updatedAt: string | null;
  /**
   * Whether a preference record exists for the user at all. Distinguishes the
   * first-time state (no record) from an explicit opt-out, so the frontend can
   * route a new user to the privacy step exactly once without treating a
   * missing record as consent — or forcing returning users through it again.
   */
  exists: boolean;
}

function emptyPreferences(): PreferencesPayload {
  return { marketingEmail: false, updatedAt: null, exists: false };
}

/**
 * The signed-in user's own communication preferences. Defaults to opt-out
 * when no row exists yet (consent is never assumed).
 */
export const getPrivacyPreferences = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();

  const row = await prisma.privacyPreference.findUnique({
    where: { userId: req.user.id },
    select,
  });

  res.status(200).json({
    success: true,
    data: {
      preferences: row ? { ...row, exists: true } : emptyPreferences(),
    },
  });
});

/** Upserts the signed-in user's consent flags. */
export const updatePrivacyPreferences = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();

  const input = privacyPreferencesSchema.parse(req.body);

  const row = await prisma.privacyPreference.upsert({
    where: { userId: req.user.id },
    update: { marketingEmail: input.marketingEmail },
    create: { userId: req.user.id, marketingEmail: input.marketingEmail },
    select,
  });

  res.status(200).json({
    success: true,
    data: {
      preferences: { ...row, exists: true },
      message: input.marketingEmail
        ? 'You will now receive occasional product updates and offers. You can opt out anytime.'
        : 'You have unsubscribed from marketing emails. Transactional messages continue as usual.',
    },
  });
});