/**
 * Optional Redis cache for PUBLIC catalogue reads only.
 *
 * Guarantees:
 *  - Never a hard dependency: when `REDIS_URL` is unset or the server is
 *    unreachable, every call falls back to a direct PostgreSQL read. The API
 *    never fails or hangs because of the cache.
 *  - Short TTL (default 60s, overridable) so a stale catalogue self-heals.
 *  - Nothing private is ever cached: only the already-public product list and
 *    slug lookups (same envelope the client gets). Sessions, orders, addresses
 *    and inquiries are never stored here.
 *  - Product writes (none exist in-app today, but the hook is ready) call
 *    `invalidateCatalog()` so the next read re-pulls from PostgreSQL.
 */
import { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { logger } from './logger.js';

const CACHE_KEY_PREFIX = 'catalog:';
const CACHE_TTL_SECONDS = env.CACHE_TTL_SECONDS;

let client: Redis | null = null;
let connectAttempted = false;
let reportedDown = false;
let lastError: string | null = null;

function redis(): Redis | null {
  if (!env.REDIS_URL) return null;
  if (!connectAttempted) {
    connectAttempted = true;
    try {
      // maxRetriesPerRequest keeps a single failing call fast; retryStrategy
      // backs off at most once a second so a Redis restart is picked up again.
      client = new Redis(env.REDIS_URL, {
        connectTimeout: 2000,
        maxRetriesPerRequest: 2,
        enableOfflineQueue: false,
        retryStrategy: (times) => Math.min(times * 500, 5000),
      });
      client.on('error', (err) => {
        // Remember the last real error (credential-free) so the health probe can
        // report WHY Redis is unavailable, without leaking the connection URL.
        lastError = sanitizeRedisError(err);
        if (!reportedDown) {
          reportedDown = true;
          logger.warn('cache_unavailable', { message: lastError });
        }
      });
      client.on('connect', () => {
        lastError = null;
        if (reportedDown) {
          reportedDown = false;
          logger.info('cache_connected');
        }
      });
    } catch {
      client = null;
    }
  }
  return client;
}

/** True when a cache is configured (not necessarily reachable right now). */
export function isCacheConfigured(): boolean {
  return Boolean(env.REDIS_URL);
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  const c = redis();
  if (!c) return null;
  try {
    const raw = await c.get(CACHE_KEY_PREFIX + key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function cacheSet(key: string, value: unknown, ttlSeconds = CACHE_TTL_SECONDS): Promise<void> {
  const c = redis();
  if (!c) return;
  try {
    await c.set(CACHE_KEY_PREFIX + key, JSON.stringify(value), 'EX', ttlSeconds);
  } catch {
    // Fallback: the request already has the data from PostgreSQL.
  }
}

/**
 * Drops every catalogue key so the next read re-pulls from the database.
 * Uses a cursor-based SCAN (not the blocking KEYS command) and only ever
 * deletes keys under the `catalog:` prefix, so unrelated keys are untouched.
 */
export async function invalidateCatalog(): Promise<void> {
  const c = redis();
  if (!c) return;
  try {
    let cursor = '0';
    do {
      const [next, keys] = await c.scan(cursor, 'MATCH', `${CACHE_KEY_PREFIX}*`, 'COUNT', 100);
      cursor = next;
      if (keys.length > 0) await c.del(...keys);
    } while (cursor !== '0');
  } catch {
    // TTL will expire any stragglers; the database remains the source of truth.
  }
}

/** Close the connection on shutdown so the process can exit cleanly. */
export async function closeCache(): Promise<void> {
  const c = client;
  client = null;
  connectAttempted = false;
  reportedDown = false;
  lastError = null;
  if (!c) return;
  try {
    // quit() flushes pending replies before closing; fall back to an immediate
    // disconnect if the client is already in a broken/reconnecting state.
    await c.quit();
  } catch {
    try {
      c.disconnect();
    } catch {
      // ignore
    }
  }
}

/** Minimal cache state for diagnostics: never reveals host/credentials/errors. */
export type CacheStatus = 'disabled' | 'connected' | 'unavailable';

/**
 * Report the cache's connection state WITHOUT initiating a connection or
 * issuing any command — safe to call from a health endpoint. When configured
 * but not yet established (the client connects lazily on first use), the state
 * is reported as `unavailable` rather than opening a fresh socket.
 */
export function cacheStatus(): CacheStatus {
  if (!env.REDIS_URL) return 'disabled';
  return client && client.status === 'ready' ? 'connected' : 'unavailable';
}

/** Removes any password/userinfo from a Redis URL that could appear in an error. */
export function sanitizeRedisError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/(rediss?:\/\/)[^@\s/]*@/gi, '$1***@');
}

/** Minimal client surface the probe depends on (injectable for tests). */
export interface ProbeRedisClient {
  status: string;
  ping(): Promise<string>;
  once(event: 'ready', listener: () => void): unknown;
  off(event: 'ready', listener: () => void): unknown;
}

export interface CacheProbe {
  status: CacheStatus;
  /** Credential-free error message when unavailable; null otherwise. */
  error: string | null;
}

/** Resolves true once the client reaches 'ready', or false after `timeoutMs`. */
function waitForReady(client: ProbeRedisClient, timeoutMs: number): Promise<boolean> {
  if (client.status === 'ready') return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const onReady = () => {
      cleanup();
      resolve(true);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve(client.status === 'ready');
    }, timeoutMs);
    function cleanup(): void {
      clearTimeout(timer);
      client.off('ready', onReady);
    }
    client.once('ready', onReady);
  });
}

/**
 * Actively verifies a Redis client with a PING, bounded by `timeoutMs`. Unlike
 * `cacheStatus()`, this waits on the (lazily-created) connection, so it reflects
 * TRUE reachability instead of "not yet connected". The returned error is
 * credential-free (see `sanitizeRedisError`) and this function never throws.
 */
export async function probeRedis(
  client: ProbeRedisClient,
  getLastError: () => string | null,
  timeoutMs = 1500,
): Promise<CacheProbe> {
  if (client.status !== 'ready') {
    const ready = await waitForReady(client, timeoutMs);
    if (!ready) {
      // Read the error AFTER the wait so a connection failure that arrives while
      // we are waiting is reported instead of a generic timeout.
      return { status: 'unavailable', error: getLastError() ?? 'connection_timeout' };
    }
  }
  try {
    const pong = await client.ping();
    return pong === 'PONG'
      ? { status: 'connected', error: null }
      : { status: 'unavailable', error: 'unexpected_ping_reply' };
  } catch (err) {
    return { status: 'unavailable', error: sanitizeRedisError(err) };
  }
}

/**
 * Health-ready probe: PINGs Redis and reports the real status/error. Bounded,
 * never throws, and never exposes the connection URL or any secret. Returns
 * `disabled` (without connecting) when `REDIS_URL` is unset.
 */
export async function probeCache(timeoutMs = 1500): Promise<CacheProbe> {
  if (!env.REDIS_URL) return { status: 'disabled', error: null };
  const c = redis();
  if (!c) return { status: 'unavailable', error: lastError ?? 'client_unavailable' };
  return probeRedis(c, () => lastError, timeoutMs);
}