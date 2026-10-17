import type { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler.js';
import {
  FIREBASE_SESSION_COOKIE,
  clearFirebaseSessionCookie,
  setFirebaseSessionCookie,
} from '../../utils/cookies.js';
import { firebaseSessionSchema } from '../../schemas/auth.schema.js';
import * as firebaseService from './firebase.service.js';

/**
 * POST /auth/firebase/session
 * Body: { idToken }. Verifies the Firebase ID token server-side and issues a
 * hardened, HttpOnly session cookie. The response only contains the public
 * user (never the token or any credential).
 */
export const createSession = asyncHandler(async (req: Request, res: Response) => {
  const { idToken } = firebaseSessionSchema.parse(req.body);
  const { cookie, user } = await firebaseService.createFirebaseSession(idToken);

  setFirebaseSessionCookie(res, cookie, firebaseService.sessionCookieMaxAgeMs());
  res.status(200).json({
    success: true,
    data: { user },
  });
});

/**
 * POST /auth/firebase/logout
 * Revokes the Firebase session (refresh tokens) and clears the session cookie.
 */
export const logout = asyncHandler(async (req: Request, res: Response) => {
  const cookie = req.cookies?.[FIREBASE_SESSION_COOKIE] as string | undefined;
  await firebaseService.revokeFirebaseSession(cookie);
  clearFirebaseSessionCookie(res);
  res.status(200).json({
    success: true,
    data: { message: 'Signed out' },
  });
});
