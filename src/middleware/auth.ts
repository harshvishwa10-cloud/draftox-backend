import type { RequestHandler } from 'express';
import { prisma } from '../lib/prisma.js';
import { ApiError } from '../utils/ApiError.js';
import {
  FIREBASE_SESSION_COOKIE,
  SESSION_COOKIE,
  clearFirebaseSessionCookie,
  clearSessionCookie,
  hashToken,
} from '../utils/cookies.js';
import { isAuthorizedAdmin, isAuthorizedSupport } from '../modules/auth/authorization.js';
import { resolveUserFromSessionCookie } from '../modules/auth/firebase.service.js';

export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string;
  role: 'CUSTOMER' | 'ADMIN';
  /** Persisted provider-verification flag for the account (may be stale). */
  emailVerified: boolean;
  /**
   * True only when THIS request's own credential (the signed Firebase session
   * cookie or the legacy session) proves a provider-verified email. Privilege
   * checks (admin/support) use this strict signal, never the persisted flag or a
   * possibly-stale custom claim.
   */
  providerVerified: boolean;
  /**
   * Which mechanism authenticated this request. Both `firebase` and `session`
   * resolve their effective role from the authorized-admin email allow-list +
   * a verified email (server-side policy); the client never supplies it.
   */
  authSource?: 'session' | 'firebase';
}

const USER_SELECT = {
  id: true,
  email: true,
  name: true,
  role: true,
  emailVerified: true,
} as const;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

export const requireAuth: RequestHandler = async (req, res, next) => {
  try {
    // Firebase server-managed session takes precedence when present. A valid
    // Firebase session is verified server-side; an invalid/expired one is
    // cleared and we fall back to the legacy session cookie before denying.
    const firebaseCookie = req.cookies?.[FIREBASE_SESSION_COOKIE] as string | undefined;
    if (firebaseCookie) {
      const firebaseUser = await resolveUserFromSessionCookie(firebaseCookie);
      if (firebaseUser) {
        req.user = firebaseUser;
        next();
        return;
      }
      clearFirebaseSessionCookie(res);
    }

    const token = req.cookies?.[SESSION_COOKIE] as string | undefined;
    if (!token) {
      throw ApiError.unauthorized();
    }

    const session = await prisma.session.findUnique({
      where: { tokenHash: hashToken(token) },
      include: {
        user: { select: USER_SELECT },
      },
    });

    if (!session || session.expiresAt.getTime() <= Date.now()) {
      if (session) {
        await prisma.session.delete({ where: { id: session.id } }).catch(() => undefined);
      }
      clearSessionCookie(res);
      throw ApiError.unauthorized('Session expired, please sign in again');
    }

    req.user = {
      ...session.user,
      authSource: 'session',
      // For a legacy session the persisted flag IS the provider-verification
      // proof (it is only ever set by a verified Google/Firebase sign-in).
      providerVerified: session.user.emailVerified,
    };

    // Refresh lastUsedAt opportunistically (do not block the request on failure)
    prisma.session
      .update({ where: { id: session.id }, data: { lastUsedAt: new Date() } })
      .catch(() => undefined);

    next();
  } catch (err) {
    next(err);
  }
};

export const optionalAuth: RequestHandler = async (req, _res, next) => {
  try {
    const firebaseCookie = req.cookies?.[FIREBASE_SESSION_COOKIE] as string | undefined;
    if (firebaseCookie) {
      const firebaseUser = await resolveUserFromSessionCookie(firebaseCookie);
      if (firebaseUser) {
        req.user = firebaseUser;
        next();
        return;
      }
    }

    const token = req.cookies?.[SESSION_COOKIE] as string | undefined;
    if (!token) {
      next();
      return;
    }
    const session = await prisma.session.findUnique({
      where: { tokenHash: hashToken(token) },
      include: {
        user: { select: USER_SELECT },
      },
    });
    if (session && session.expiresAt.getTime() > Date.now()) {
      req.user = {
        ...session.user,
        authSource: 'session',
        providerVerified: session.user.emailVerified,
      };
    }
    next();
  } catch (err) {
    next(err);
  }
};

/**
 * Admin-only gate. Must be mounted AFTER `requireAuth` so `req.user` is set.
 * Authorization is enforced here on the server and is never derived from the
 * database role alone, the UI, or any client-supplied value.
 *
 * Both authentication paths resolve an effective role from the same server-side
 * policy — authorized admin email allow-list + a verified email — before this
 * gate runs:
 * - Firebase sessions: the role was computed in the service from the signed
 *   session cookie (verified email), never from the stored column or a
 *   possibly-stale `admin` claim.
 * - Legacy sessions: an authorized admin email + a provider-verified email.
 */
export const requireAdmin: RequestHandler = (req, _res, next) => {
  if (!req.user) {
    next(ApiError.unauthorized());
    return;
  }
  const isAdmin =
    req.user.authSource === 'firebase'
      ? req.user.role === 'ADMIN'
      : isAuthorizedAdmin(req.user);
  if (!isAdmin) {
    next(ApiError.forbidden('Admin access is required for this resource'));
    return;
  }
  next();
};

/**
 * Restricted public-request-inbox gate. Must be mounted AFTER `requireAuth` so
 * `req.user` is set. It passes for a FULL administrator (exactly like
 * `requireAdmin`) OR for a configured support account that presented a
 * provider-verified email in THIS request's credential. It is deliberately used
 * ONLY for the contact/product/support enquiry inbox and the owner-notification
 * retry — every financial, order, shipment, refund, payment and returns route
 * stays behind the full-admin `requireAdmin` gate.
 */
export const requireSupportOrAdmin: RequestHandler = (req, _res, next) => {
  if (!req.user) {
    next(ApiError.unauthorized());
    return;
  }
  const isAdmin =
    req.user.authSource === 'firebase'
      ? req.user.role === 'ADMIN'
      : isAuthorizedAdmin(req.user);
  if (isAdmin) {
    next();
    return;
  }
  // Support: authorized email + a provider-verified email proven by THIS
  // request's credential (the strict `providerVerified` signal, not the looser
  // persisted column and not a client-supplied value).
  if (isAuthorizedSupport({ email: req.user.email, emailVerified: req.user.providerVerified })) {
    next();
    return;
  }
  next(ApiError.forbidden('Support or admin access is required for this resource'));
};
