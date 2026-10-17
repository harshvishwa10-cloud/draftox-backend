import { z } from 'zod';

export const privacyPreferencesSchema = z.object({
  marketingEmail: z.boolean(),
});

export type PrivacyPreferencesInput = z.infer<typeof privacyPreferencesSchema>;