import rateLimit from 'express-rate-limit';
import { env } from '../config/env.js';
import { ApiError } from '../utils/ApiError.js';
import { createRateLimitStore, type RateLimitScope } from './rateLimitStore.js';

function buildLimiter(scope: RateLimitScope, windowMs: number, max: number) {
  // Each limiter gets its own scoped store so counters never bleed between
  // scopes. With REDIS_URL set the store is shared across instances and keys
  // live under `ratelimit:<scope>:<key>`; otherwise the default in-memory store
  // is used (single-process only).
  const store = createRateLimitStore(scope);
  return rateLimit({
    windowMs,
    max,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    ...(store ? { store } : {}),
    handler: (_req, _res, next) => {
      next(ApiError.tooMany());
    },
  });
}

export const generalLimiter = buildLimiter('general', env.RATE_LIMIT_WINDOW_MS, env.RATE_LIMIT_MAX);
export const authLimiter = buildLimiter('auth', env.AUTH_RATE_LIMIT_WINDOW_MS, env.AUTH_RATE_LIMIT_MAX);
export const inquiryLimiter = buildLimiter('inquiry', env.INQUIRY_RATE_LIMIT_WINDOW_MS, env.INQUIRY_RATE_LIMIT_MAX);
export const trackingLimiter = buildLimiter('tracking', env.TRACKING_RATE_LIMIT_WINDOW_MS, env.TRACKING_RATE_LIMIT_MAX);
