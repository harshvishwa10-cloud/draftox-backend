import type { Request, Response } from 'express';
import { env, googleOAuthConfigured } from '../../config/env.js';
import { firebaseAdminAvailable } from '../../lib/firebase/admin.js';
import { ApiError } from '../../utils/ApiError.js';
import {
  SESSION_COOKIE,
  clearOAuthStateCookie,
  clearSessionCookie,
  generateToken,
  setOAuthStateCookie,
  setSessionCookie,
  sessionMaxAgeMs,
} from '../../utils/cookies.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import {
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
} from '../../schemas/auth.schema.js';
import * as authService from './auth.service.js';
import * as googleService from './google.service.js';

function clientMeta(req: Request) {
  return {
    userAgent: req.get('user-agent'),
    ip: req.ip,
  };
}

function wantsJson(req: Request): boolean {
  const accept = req.get('accept') ?? '';
  return accept.includes('application/json') && !accept.includes('text/html');
}

export const register = asyncHandler(async (req: Request, res: Response) => {
  const input = registerSchema.parse(req.body);
  const { user, session } = await authService.register(input, clientMeta(req));

  setSessionCookie(res, session.token, sessionMaxAgeMs());
  res.status(201).json({
    success: true,
    data: { user },
  });
});

export const login = asyncHandler(async (req: Request, res: Response) => {
  const input = loginSchema.parse(req.body);
  const { user, session } = await authService.login(input, clientMeta(req));

  setSessionCookie(res, session.token, sessionMaxAgeMs());
  res.status(200).json({
    success: true,
    data: { user },
  });
});

export const logout = asyncHandler(async (req: Request, res: Response) => {
  const token = req.cookies?.[SESSION_COOKIE] as string | undefined;
  await authService.logout(token);
  clearSessionCookie(res);
  res.status(200).json({
    success: true,
    data: { message: 'Signed out' },
  });
});

export const me = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) {
    throw ApiError.unauthorized();
  }
  const user = await authService.getUserById(req.user.id);
  // Surface the role the server will actually enforce. For Firebase sessions
  // that role was computed from the signed session cookie (authorized email +
  // verified), not the stored column — so a first sign-in of a freshly-authorized
  // admin is reported correctly instead of falling back to the stale CUSTOMER
  // column. The legacy path already derives its role from the same policy.
  const role = req.user.authSource === 'firebase' ? req.user.role : user.role;
  res.status(200).json({
    success: true,
    data: { user: { ...user, role } },
  });
});

export const forgotPassword = asyncHandler(async (req: Request, res: Response) => {
  const input = forgotPasswordSchema.parse(req.body);
  const result = await authService.forgotPassword(input);
  res.status(200).json({
    success: true,
    data: result,
  });
});

export const resetPassword = asyncHandler(async (req: Request, res: Response) => {
  const input = resetPasswordSchema.parse(req.body);
  await authService.resetPassword(input);
  clearSessionCookie(res);
  res.status(200).json({
    success: true,
    data: { message: 'Password updated. Please sign in with your new password.' },
  });
});

export const providers = asyncHandler(async (_req: Request, res: Response) => {
  res.status(200).json({
    success: true,
    data: { google: googleOAuthConfigured, firebase: firebaseAdminAvailable },
  });
});

export const googleRedirect = asyncHandler(async (_req: Request, res: Response) => {
  if (!googleOAuthConfigured) {
    throw ApiError.serviceUnavailable('Google sign-in is not configured on this server');
  }
  const state = generateToken(24);
  setOAuthStateCookie(res, state);
  const url = googleService.getGoogleAuthUrl(state);
  res.redirect(302, url);
});

export const googleCallback = asyncHandler(async (req: Request, res: Response) => {
  if (!googleOAuthConfigured) {
    throw ApiError.serviceUnavailable('Google sign-in is not configured on this server');
  }

  const code = typeof req.query.code === 'string' ? req.query.code : undefined;
  const state = typeof req.query.state === 'string' ? req.query.state : undefined;
  const expectedState = req.cookies?.draftox_oauth_state as string | undefined;

  const failRedirect = (reason: string) => {
    if (wantsJson(req)) {
      throw ApiError.badRequest(reason);
    }
    res.redirect(302, `${env.FRONTEND_URL}/auth/callback?status=error&reason=${encodeURIComponent(reason)}`);
  };

  if (!code) {
    return failRedirect('missing_code');
  }
  if (!state || !expectedState || state !== expectedState) {
    clearOAuthStateCookie(res);
    return failRedirect('invalid_state');
  }
  clearOAuthStateCookie(res);

  try {
    const identity = await googleService.verifyGoogleCode(code);
    const { user, session } = await authService.upsertGoogleUser(identity, clientMeta(req));
    setSessionCookie(res, session.token, sessionMaxAgeMs());

    // An authorized admin lands on the admin dashboard; everyone else
    // continues to the normal customer experience.
    const next = user.role === 'ADMIN' ? '/admin/orders' : '/account';

    if (wantsJson(req)) {
      res.status(200).json({
        success: true,
        data: { user, next },
      });
      return;
    }
    res.redirect(
      302,
      `${env.FRONTEND_URL}/auth/callback?status=success&next=${encodeURIComponent(next)}`,
    );
  } catch (err) {
    if (err instanceof ApiError) {
      return failRedirect(err.code.toLowerCase());
    }
    // eslint-disable-next-line no-console
    console.error('google_oauth_error', err instanceof Error ? err.message : err);
    return failRedirect('oauth_failed');
  }
});
