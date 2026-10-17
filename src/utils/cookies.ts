import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { CookieOptions, Response } from 'express';
import { env, isProduction } from '../config/env.js';

export const SESSION_COOKIE = 'draftox_session';
/** Server-managed Firebase session cookie (Admin SDK createSessionCookie). */
export const FIREBASE_SESSION_COOKIE = 'draftox_fb_session';
export const CSRF_COOKIE = 'draftox_csrf';
export const CSRF_HEADER = 'x-csrf-token';
export const OAUTH_STATE_COOKIE = 'draftox_oauth_state';

export function generateToken(bytes = 48): string {
  return randomBytes(bytes).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function baseCookieOptions() {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax' as const,
    path: '/',
  };
}

export function setSessionCookie(res: Response, token: string, maxAgeMs: number): void {
  res.cookie(SESSION_COOKIE, token, {
    ...baseCookieOptions(),
    maxAge: maxAgeMs,
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, { ...baseCookieOptions(), maxAge: 0 });
}

/**
 * Writes the server-managed Firebase session cookie. It shares the hardened
 * attributes of the legacy session cookie (HttpOnly, Secure in production,
 * SameSite=Lax, path=/) so it is never readable by client JS.
 */
export function setFirebaseSessionCookie(res: Response, value: string, maxAgeMs: number): void {
  res.cookie(FIREBASE_SESSION_COOKIE, value, {
    ...baseCookieOptions(),
    maxAge: maxAgeMs,
  });
}

export function clearFirebaseSessionCookie(res: Response): void {
  res.clearCookie(FIREBASE_SESSION_COOKIE, { ...baseCookieOptions(), maxAge: 0 });
}

/**
 * Cookie attributes for the CSRF double-submit cookie. This is the ONLY cookie
 * that may carry a `Domain` attribute: unlike the HttpOnly session cookies it
 * must be readable by the storefront JS, which may be served from a sibling
 * subdomain (frontend https://draftox.in reading a cookie set by the API on
 * https://api.draftox.in). When `COOKIE_DOMAIN` is unset the `Domain` attribute
 * is omitted entirely, leaving the cookie host-only (the default behavior).
 */
export function csrfCookieOptions(domain: string | undefined): CookieOptions {
  const options: CookieOptions = {
    httpOnly: false, // must be readable by the frontend JS (double-submit)
    secure: isProduction,
    sameSite: 'lax',
    path: '/',
    maxAge: 24 * 60 * 60 * 1000,
  };
  if (domain) options.domain = domain;
  return options;
}

export function ensureCsrfCookie(res: Response, existing?: string): string {
  const token = existing ?? generateToken(32);
  res.cookie(CSRF_COOKIE, token, csrfCookieOptions(env.COOKIE_DOMAIN));
  return token;
}

export function setOAuthStateCookie(res: Response, state: string): void {
  res.cookie(OAUTH_STATE_COOKIE, state, {
    ...baseCookieOptions(),
    maxAge: 10 * 60 * 1000,
  });
}

export function clearOAuthStateCookie(res: Response): void {
  res.clearCookie(OAUTH_STATE_COOKIE, { ...baseCookieOptions(), maxAge: 0 });
}

export function sessionMaxAgeMs(): number {
  return env.SESSION_TTL_HOURS * 60 * 60 * 1000;
}
