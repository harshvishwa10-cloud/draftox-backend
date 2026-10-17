// Enables Google OAuth config, then mocks the low-level google-auth-library so
// the REAL verifyGoogleCode guard logic (verified-email requirement, email
// normalization) runs without any network access.
import './helpers/google-env.js';
import { describe, expect, it, vi } from 'vitest';

const payload: { current: Record<string, unknown> } = { current: {} };

vi.mock('google-auth-library', () => ({
  OAuth2Client: class {
    generateAuthUrl() {
      return 'https://accounts.google.com/o/oauth2/v2/auth?mock=1';
    }
    async getToken() {
      return { tokens: { id_token: 'mock-id-token' } };
    }
    async verifyIdToken() {
      return { getPayload: () => payload.current };
    }
  },
}));

async function verifyGoogleCode(code = 'test-code') {
  const mod = await import('../src/modules/auth/google.service.js');
  return mod.verifyGoogleCode(code);
}

describe('verifyGoogleCode (trusted Google identity)', () => {
  it('rejects an email Google has not verified', async () => {
    payload.current = { sub: 'g-1', email: 'owner@example.com', email_verified: false, name: 'X' };
    await expect(verifyGoogleCode()).rejects.toMatchObject({ statusCode: 403 });
  });

  it('rejects a missing email even when verified is claimed', async () => {
    payload.current = { sub: 'g-1', email_verified: true };
    await expect(verifyGoogleCode()).rejects.toMatchObject({ statusCode: 400 });
  });

  it('accepts a verified email and normalizes it', async () => {
    payload.current = {
      sub: 'g-1',
      email: '  Owner@Example.COM ',
      email_verified: true,
      name: 'Owner',
    };
    await expect(verifyGoogleCode()).resolves.toEqual({
      googleId: 'g-1',
      email: 'owner@example.com',
      name: 'Owner',
      emailVerified: true,
    });
  });
});
