import type { RequestHandler } from 'express';
import { corsOrigins } from '../config/env.js';
import { ApiError } from '../utils/ApiError.js';
import { CSRF_COOKIE, CSRF_HEADER, ensureCsrfCookie, safeEqual } from '../utils/cookies.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF protection for the cookie-based session flow:
 * 1. Double-submit token — a non-HttpOnly CSRF cookie must be echoed in the
 *    X-CSRF-Token header on every state-changing request.
 * 2. Origin check — when the browser sends an Origin header on a
 *    state-changing request it must be an allowed frontend origin.
 */
export const csrfProtection: RequestHandler = (req, _res, next) => {
  if (SAFE_METHODS.has(req.method)) {
    next();
    return;
  }

  const origin = req.headers.origin;
  if (origin && !corsOrigins.includes(origin)) {
    next(ApiError.forbidden('Origin not allowed'));
    return;
  }

  const cookieToken = (req.cookies?.[CSRF_COOKIE] as string | undefined) ?? undefined;
  const headerToken = req.get(CSRF_HEADER);

  if (!cookieToken || !headerToken || !safeEqual(cookieToken, headerToken)) {
    next(ApiError.forbidden('Invalid or missing CSRF token'));
    return;
  }

  next();
};

/**
 * Ensures every response carries a CSRF cookie so the frontend can read it
 * and echo it back on state-changing requests. If the request already sends
 * a valid cookie we keep it stable.
 */
export const ensureCsrfCookieMiddleware: RequestHandler = (req, res, next) => {
  const existing = (req.cookies?.[CSRF_COOKIE] as string | undefined) ?? undefined;
  ensureCsrfCookie(res, existing);
  next();
};
