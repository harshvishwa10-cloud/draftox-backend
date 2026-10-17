import { OAuth2Client } from 'google-auth-library';
import { env, googleOAuthConfigured } from '../../config/env.js';
import { ApiError } from '../../utils/ApiError.js';

export interface GoogleIdentity {
  googleId: string;
  email: string;
  name: string;
  emailVerified: boolean;
}

function getClient(): OAuth2Client {
  if (!googleOAuthConfigured) {
    throw ApiError.serviceUnavailable('Google sign-in is not configured on this server');
  }
  return new OAuth2Client({
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    redirectUri: env.GOOGLE_CALLBACK_URL,
  });
}

export function getGoogleAuthUrl(state: string): string {
  const client = getClient();
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'select_account',
    scope: ['openid', 'email', 'profile'],
    state,
  });
}

export async function verifyGoogleCode(code: string): Promise<GoogleIdentity> {
  const client = getClient();
  const { tokens } = await client.getToken(code);
  if (!tokens.id_token) {
    throw ApiError.badRequest('Google did not return an identity token');
  }

  const ticket = await client.verifyIdToken({
    idToken: tokens.id_token,
    audience: env.GOOGLE_CLIENT_ID,
  });

  const payload = ticket.getPayload();
  if (!payload || !payload.sub || !payload.email) {
    throw ApiError.badRequest('Could not verify Google identity');
  }

  // Only trust accounts whose email Google has verified.
  if (payload.email_verified !== true) {
    throw ApiError.forbidden('Google account email is not verified');
  }

  return {
    googleId: payload.sub,
    email: payload.email.trim().toLowerCase(),
    name: (payload.name ?? payload.email.split('@')[0]).trim(),
    emailVerified: true,
  };
}
