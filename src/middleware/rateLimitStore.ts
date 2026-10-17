/**
 * Redis-backed store for `express-rate-limit` so limits hold ACROSS multiple
 * API instances (an in-memory store only limits per process).
 *
 * Resilience first: when Redis is unset or unreachable, every operation falls
 * back to an in-process MemoryStore. Rate limiting therefore keeps working
 * (locally) instead of failing requests or blocking on a dead Redis — matching
 * the existing "the API never fails because Redis is unavailable" contract.
 *
 * Namespacing: every independently configured limiter passes a stable `scope`
 * so its Redis keys are `ratelimit:<scope>:<key>`. Without this, several
 * limiters sharing one prefix would collide on the same IP key and bleed their
 * counters/windows into each other. Scopes are isolated from each other for
 * increment, decrement, resetKey and resetAll.
 */
import { MemoryStore, type IncrementResponse, type Options, type Store } from 'express-rate-limit';
import { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

/** Stable identifiers for each independently configured limiter. */
export type RateLimitScope = 'general' | 'auth' | 'inquiry' | 'tracking';

const KEY_PREFIX_ROOT = 'ratelimit';
const FALLBACK_NAMESPACE = 'local:';

/** Minimal subset of the ioredis client the store depends on (injectable for tests). */
export interface RedisRateLimitClient {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
  scan(cursor: string, ...args: (string | number)[]): Promise<[string, string[]]>;
}

/** Stable, per-scope Redis key: `ratelimit:<scope>:<clientKey>`. */
export function rateLimitKey(scope: RateLimitScope, key: string): string {
  return `${KEY_PREFIX_ROOT}:${scope}:${key}`;
}

/** Glob pattern matching every key owned by a single scope. */
export function rateLimitPattern(scope: RateLimitScope): string {
  return `${KEY_PREFIX_ROOT}:${scope}:*`;
}

/** Atomically increment + set TTL on first hit; returns total hits and PTTL. */
const INCR_SCRIPT = `
local hits = redis.call('INCR', KEYS[1])
if hits == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local pttl = redis.call('PTTL', KEYS[1])
return { hits, pttl }
`;

/**
 * Atomically decrement an EXISTING counter and clamp at zero. A no-op when the
 * key is absent, so a stray decrement (e.g. from skipSuccessfulRequests) can
 * never create a counter. Clamping uses KEEPTTL so the window is preserved; it
 * never leaves a key without an expiry (which would leak memory forever).
 */
const DECR_SCRIPT = `
local exists = redis.call('EXISTS', KEYS[1])
if exists == 0 then
  return -1
end
local value = redis.call('DECR', KEYS[1])
if value < 0 then
  redis.call('SET', KEYS[1], 0, 'KEEPTTL')
  return 0
end
return value
`;

export class ResilientRedisStore implements Store {
  /** Keys are shared across instances, so this is NOT a local-only store. */
  readonly localKeys = false;

  /**
   * Distinct per scope. express-rate-limit only reads this for its
   * "double count" validation: without it, every scoped store shares the same
   * constructor name and the same IP key, so a request legitimately passing two
   * scopes (e.g. the global general limiter + the auth limiter) would be
   * mis-flagged as a double count. It is NOT used to build the Redis key — that
   * is `rateLimitKey(scope, key)` in `increment`.
   */
  readonly prefix: string;

  private readonly fallback = new MemoryStore();
  private readonly scope: RateLimitScope;
  private client: RedisRateLimitClient | null = null;
  private windowMs = 60_000;

  constructor(scope: RateLimitScope, client: RedisRateLimitClient | null = null) {
    this.scope = scope;
    this.client = client;
    this.prefix = `${KEY_PREFIX_ROOT}:${scope}:`;
  }

  init(options: Options): void {
    this.windowMs = options.windowMs;
    this.fallback.init(options);
  }

  async increment(key: string): Promise<IncrementResponse> {
    if (!this.client) return this.fallback.increment(FALLBACK_NAMESPACE + key);
    try {
      const raw = (await this.client.eval(
        INCR_SCRIPT,
        1,
        rateLimitKey(this.scope, key),
        String(this.windowMs),
      )) as [number | string, number | string];
      const totalHits = Number(raw[0]);
      const pttl = Number(raw[1]);
      const resetTime = new Date(Date.now() + (pttl > 0 ? pttl : this.windowMs));
      return { totalHits, resetTime };
    } catch (err) {
      logger.warn('ratelimit_redis_fallback', {
        message: err instanceof Error ? err.message : String(err),
      });
      return this.fallback.increment(FALLBACK_NAMESPACE + key);
    }
  }

  async decrement(key: string): Promise<void> {
    if (!this.client) {
      await this.fallback.decrement(FALLBACK_NAMESPACE + key);
      return;
    }
    try {
      await this.client.eval(DECR_SCRIPT, 1, rateLimitKey(this.scope, key));
    } catch {
      await this.fallback.decrement(FALLBACK_NAMESPACE + key);
    }
  }

  async resetKey(key: string): Promise<void> {
    if (!this.client) {
      await this.fallback.resetKey(FALLBACK_NAMESPACE + key);
      return;
    }
    try {
      await this.client.del(rateLimitKey(this.scope, key));
    } catch {
      await this.fallback.resetKey(FALLBACK_NAMESPACE + key);
    }
  }

  async resetAll(): Promise<void> {
    await this.fallback.resetAll();
    if (!this.client) return;
    try {
      // Cursor-based SCAN instead of the blocking KEYS command, limited to this
      // scope's pattern so another scope's counters are never touched.
      let cursor = '0';
      do {
        const [next, found] = await this.client.scan(
          cursor,
          'MATCH',
          rateLimitPattern(this.scope),
          'COUNT',
          100,
        );
        cursor = next;
        if (found.length > 0) await this.client.del(...found);
      } while (cursor !== '0');
    } catch {
      // TTLs will expire the counters; not fatal.
    }
  }
}

/** Builds a real ioredis client, or null when construction throws. */
function createRedisClient(url: string): RedisRateLimitClient | null {
  try {
    const client = new Redis(url, {
      connectTimeout: 2000,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      retryStrategy: (times) => Math.min(times * 500, 5000),
    });
    client.on('error', () => {
      // Swallowed: increment() falls back to memory. Avoid log spam by not
      // logging here; the cache module already reports Redis availability.
    });
    return client as unknown as RedisRateLimitClient;
  } catch {
    return null;
  }
}

/**
 * Returns a Redis-backed store scoped to `scope` when `REDIS_URL` is set,
 * otherwise `undefined` (letting express-rate-limit use its default in-memory
 * store). Each scope gets an isolated Redis namespace.
 */
export function createRateLimitStore(scope: RateLimitScope): Store | undefined {
  if (!env.REDIS_URL) return undefined;
  return new ResilientRedisStore(scope, createRedisClient(env.REDIS_URL));
}
