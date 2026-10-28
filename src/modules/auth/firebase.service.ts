/**
 * Server-side Firebase Authentication integration.
 *
 * The browser obtains a Firebase ID token (Google popup/redirect) and posts it
 * here. The token is re-verified on the server with the Admin SDK, mapped to a
 * DRAFTOX user, and exchanged for an HttpOnly, server-managed Firebase SESSION
 * COOKIE. Every subsequent request is authenticated by verifying that cookie —
 * the client never supplies an identity or a role.
 *
 * Administrator access is decided by the same server-side policy used
 * everywhere else: the email must be on the configured allow-list
 * (`ADMIN_EMAIL` + `ADMIN_EMAILS`) AND be verified in the server-verified
 * session cookie / ID token. The optional `admin` custom claim is still written
 * with Admin SDK credentials (so it cannot be forged from the browser), but it
 * is NOT the deciding factor: a custom claim only appears in tokens minted
 * AFTER it is set, while the session cookie is created from the ID token the
 * browser already holds — so the claim lags the very first sign-in of a
 * newly-authorized admin. The `email` and `email_verified` claims are covered
 * by the cookie's signature and never come from the client.
 */
import type { User } from '@prisma/client';
import type { DecodedIdToken } from 'firebase-admin/auth';
import { firebaseSessionTtlMs } from '../../config/env.js';
import { getFirebaseAuth } from '../../lib/firebase/admin.js';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { ApiError } from '../../utils/ApiError.js';
import { normalizeEmail } from '../../utils/normalize.js';
import {
  effectiveRole,
  isAuthorizedAdmin,
  isAuthorizedAdminEmail,
  isReservedPrivilegedEmail,
} from './authorization.js';
import { toPublicUser, type PublicUser } from './auth.service.js';

export interface FirebaseSessionResult {
  cookie: string;
  user: PublicUser;
}

/** Cookie max-age (ms) matching the server-managed Firebase session lifetime. */
export function sessionCookieMaxAgeMs(): number {
  return firebaseSessionTtlMs;
}

export interface ResolvedFirebaseUser {
  id: string;
  email: string;
  name: string;
  role: 'CUSTOMER' | 'ADMIN';
  emailVerified: boolean;
  /** Verified in THIS signed session cookie (the strict privilege signal). */
  providerVerified: boolean;
  authSource: 'firebase';
}

function requireAuthInstance() {
  const auth = getFirebaseAuth();
  if (!auth) {
    throw ApiError.serviceUnavailable('Firebase sign-in is not configured on this server');
  }
  return auth;
}

/**
 * Extracts a DRAFTOX-safe identity from verified Firebase claims. Returns null
 * when the token carries no usable email (e.g. anonymous or provider-less).
 */
function identityFromClaims(claims: DecodedIdToken): {
  uid: string;
  email: string;
  emailVerified: boolean;
  name: string | undefined;
} | null {
  const email = typeof claims.email === 'string' ? normalizeEmail(claims.email) : '';
  if (!email) return null;
  return {
    uid: claims.uid,
    email,
    emailVerified: claims.email_verified === true,
    name: typeof claims.name === 'string' ? claims.name : undefined,
  };
}

/**
 * Finds or creates the DRAFTOX user for a verified Firebase identity. The email
 * comes from Firebase's verified token, never from the client body. A previously
 * verified email is never downgraded.
 */
async function upsertUserForIdentity(identity: {
  uid: string;
  email: string;
  emailVerified: boolean;
  name?: string;
}): Promise<User> {
  const existing = await prisma.user.findUnique({ where: { email: identity.email } });
  const isPrivilegedEmail = isReservedPrivilegedEmail(identity.email);

  if (existing) {
    return prisma.user.update({
      where: { id: existing.id },
      data: {
        emailVerified: existing.emailVerified || identity.emailVerified,
        // Firebase email/password or Google accounts are not password accounts on
        // DRAFTOX. For an authorized admin OR support email, never leave a
        // password attached (the provider is the only credential), mirroring the
        // Google OAuth rule and closing the pre-registration window.
        ...(isPrivilegedEmail ? { passwordHash: null } : {}),
      },
    });
  }

  return prisma.user.create({
    data: {
      name: (identity.name?.slice(0, 100) || identity.email.split('@')[0]) ?? 'Customer',
      email: identity.email,
      passwordHash: null, // Firebase-managed account
      emailVerified: identity.emailVerified,
      role: 'CUSTOMER',
    },
  });
}

/**
 * Grants the server-side `admin` custom claim to an authorized admin email
 * (idempotent, only when the email is verified). Never grants it to any other
 * account. Failures are logged but do not block sign-in — the claim is set on
 * the next successful exchange.
 */
async function syncAdminClaim(uid: string, email: string, emailVerified: boolean): Promise<void> {
  if (!isAuthorizedAdminEmail(email) || !emailVerified) return;
  const auth = getFirebaseAuth();
  if (!auth) return;
  try {
    const record = await auth.getUser(uid);
    if (record.customClaims?.admin === true) return;
    await auth.setCustomUserClaims(uid, { ...(record.customClaims ?? {}), admin: true });
  } catch (err) {
    logger.error('firebase_admin_claim_sync_failed', {
      uid,
      error: err instanceof Error ? err.message : 'unknown',
    });
  }
}

/**
 * Exchanges a verified Firebase ID token for a server-managed session cookie.
 * Throws 401 for any invalid/expired/revoked token; the raw token is never
 * echoed back and no claim is trusted before verification.
 */
export async function createFirebaseSession(idToken: string): Promise<FirebaseSessionResult> {
  const auth = requireAuthInstance();

  let decoded: DecodedIdToken;
  try {
    decoded = await auth.verifyIdToken(idToken, true);
  } catch {
    throw ApiError.unauthorized('Invalid or expired sign-in token');
  }

  const identity = identityFromClaims(decoded);
  if (!identity) {
    throw ApiError.badRequest('The sign-in token does not include a verified email address');
  }

  const user = await upsertUserForIdentity(identity);
  await syncAdminClaim(identity.uid, identity.email, identity.emailVerified);

  let cookie: string;
  try {
    cookie = await auth.createSessionCookie(idToken, { expiresIn: firebaseSessionTtlMs });
  } catch {
    throw ApiError.unauthorized('Unable to establish a session, please sign in again');
  }

  // The role reported here is the one this session will actually enforce on
  // the next request: authorized email + VERIFIED IN THIS TOKEN. Deriving it
  // from the token rather than the stored column keeps the response honest for
  // a first sign-in (the `admin` claim is not in the cookie yet) and never
  // surfaces ADMIN for an unverified sign-in.
  const publicUser: PublicUser = {
    ...toPublicUser(user),
    role: effectiveRole({ email: identity.email, emailVerified: identity.emailVerified }),
  };
  return { cookie, user: publicUser };
}

/**
 * Verifies a server-managed Firebase session cookie and resolves the matching
 * DRAFTOX user. Returns null (never throws) when Firebase is unavailable, the
 * cookie is missing/invalid/revoked, or no local user matches.
 */
export async function resolveUserFromSessionCookie(
  cookieValue: string | undefined,
): Promise<ResolvedFirebaseUser | null> {
  if (!cookieValue) return null;
  const auth = getFirebaseAuth();
  if (!auth) return null;

  let decoded: DecodedIdToken;
  try {
    decoded = await auth.verifySessionCookie(cookieValue, true);
  } catch {
    return null;
  }

  const email = typeof decoded.email === 'string' ? normalizeEmail(decoded.email) : '';
  if (!email) return null;

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return null;

  // Authoritative, server-side decision computed from the SIGNED session
  // cookie: allow-list membership + an email verified IN THIS TOKEN. The stored
  // `role` column and the (possibly lagging) `admin` custom claim are
  // deliberately NOT consulted — a claim only exists in tokens minted after it
  // is written, and this cookie was minted from an older token, which is why a
  // freshly-authorized admin could otherwise be stuck as CUSTOMER.
  const emailVerified = decoded.email_verified === true;
  const admin = isAuthorizedAdmin({ email, emailVerified });

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: admin ? 'ADMIN' : 'CUSTOMER',
    emailVerified: user.emailVerified || emailVerified,
    providerVerified: emailVerified,
    authSource: 'firebase',
  };
}

/**
 * Revokes the Firebase refresh tokens for the session's user so the session
 * cookie is rejected on subsequent verification. Best-effort: a missing or
 * already-invalid cookie is a no-op.
 */
export async function revokeFirebaseSession(cookieValue: string | undefined): Promise<void> {
  if (!cookieValue) return;
  const auth = getFirebaseAuth();
  if (!auth) return;
  try {
    const decoded = await auth.verifySessionCookie(cookieValue, true);
    await auth.revokeRefreshTokens(decoded.uid);
  } catch {
    // Expired/invalid cookie — nothing to revoke.
  }
}
