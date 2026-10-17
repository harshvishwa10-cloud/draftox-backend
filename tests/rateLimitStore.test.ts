import { describe, expect, it } from 'vitest';
import type { Options } from 'express-rate-limit';
import {
  ResilientRedisStore,
  createRateLimitStore,
  rateLimitKey,
  rateLimitPattern,
  type RedisRateLimitClient,
} from '../src/middleware/rateLimitStore.js';

/** Minimal in-memory stand-in for ioredis covering only the commands the store uses. */
class FakeRedis implements RedisRateLimitClient {
  readonly evalKeys: string[] = [];
  readonly scans: string[] = [];
  private readonly values = new Map<string, number>();
  private readonly ttls = new Map<string, number>();
  private readonly failEval: boolean;

  constructor(opts: { failEval?: boolean } = {}) {
    this.failEval = opts.failEval ?? false;
  }

  private globToRegExp(pattern: string): RegExp {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`);
  }

  async eval(script: string, _numKeys: number, ...args: (string | number)[]): Promise<unknown> {
    if (this.failEval) throw new Error('redis unreachable');
    const key = String(args[0]);
    if (script.includes('DECR')) {
      if (!this.values.has(key)) return -1;
      const next = (this.values.get(key) ?? 0) - 1;
      if (next < 0) {
        this.values.set(key, 0);
        return 0;
      }
      this.values.set(key, next);
      return next;
    }
    const ttl = Number(args[1]);
    this.evalKeys.push(key);
    const hits = (this.values.get(key) ?? 0) + 1;
    this.values.set(key, hits);
    if (hits === 1) this.ttls.set(key, ttl);
    return [hits, this.ttls.get(key) ?? -1];
  }

  async del(...keys: string[]): Promise<unknown> {
    let removed = 0;
    for (const key of keys) {
      if (this.values.delete(key) || this.ttls.delete(key)) removed += 1;
    }
    return removed;
  }

  async scan(_cursor: string, ...args: (string | number)[]): Promise<[string, string[]]> {
    const pattern = String(args[1]);
    this.scans.push(pattern);
    const re = this.globToRegExp(pattern);
    return ['0', [...this.values.keys()].filter((key) => re.test(key))];
  }

  keysSnapshot(): string[] {
    return [...this.values.keys()].sort();
  }

  ttlSnapshot(): [string, number][] {
    return [...this.ttls.entries()].sort();
  }
}

const windowOptions = (windowMs: number) => ({ windowMs } as unknown as Options);

describe('rateLimitKey / rateLimitPattern', () => {
  it('namespaces each key by scope', () => {
    expect(rateLimitKey('auth', '1.2.3.4')).toBe('ratelimit:auth:1.2.3.4');
    expect(rateLimitKey('general', '1.2.3.4')).toBe('ratelimit:general:1.2.3.4');
    expect(rateLimitPattern('tracking')).toBe('ratelimit:tracking:*');
  });

  it('exposes a distinct prefix per scope (so two scopes are not a false double-count)', () => {
    const auth = new ResilientRedisStore('auth');
    const general = new ResilientRedisStore('general');
    const tracking = new ResilientRedisStore('tracking');

    expect(auth.prefix).toBe('ratelimit:auth:');
    expect(general.prefix).toBe('ratelimit:general:');
    expect(tracking.prefix).toBe('ratelimit:tracking:');
    expect(new Set([auth.prefix, general.prefix, tracking.prefix]).size).toBe(3);
    // localKeys must stay false: counters are shared across instances.
    expect(auth.localKeys).toBe(false);
  });
});

describe('ResilientRedisStore scope isolation', () => {
  it('writes each scope to a distinct Redis key for the same client key', async () => {
    const fake = new FakeRedis();
    const auth = new ResilientRedisStore('auth', fake);
    const general = new ResilientRedisStore('general', fake);
    auth.init(windowOptions(60_000));
    general.init(windowOptions(900_000));

    await auth.increment('1.2.3.4');
    await auth.increment('1.2.3.4');
    await general.increment('1.2.3.4');

    expect(fake.evalKeys).toEqual([
      'ratelimit:auth:1.2.3.4',
      'ratelimit:auth:1.2.3.4',
      'ratelimit:general:1.2.3.4',
    ]);
  });

  it('keeps counters independent per scope', async () => {
    const fake = new FakeRedis();
    const auth = new ResilientRedisStore('auth', fake);
    const general = new ResilientRedisStore('general', fake);
    auth.init(windowOptions(60_000));
    general.init(windowOptions(900_000));

    expect((await auth.increment('9.9.9.9')).totalHits).toBe(1);
    expect((await general.increment('9.9.9.9')).totalHits).toBe(1);
    expect((await auth.increment('9.9.9.9')).totalHits).toBe(2);
  });

  it('resetKey only clears the calling scope', async () => {
    const fake = new FakeRedis();
    const auth = new ResilientRedisStore('auth', fake);
    const general = new ResilientRedisStore('general', fake);
    auth.init(windowOptions(60_000));
    general.init(windowOptions(900_000));

    await auth.increment('1.1.1.1');
    await general.increment('1.1.1.1');
    await auth.resetKey('1.1.1.1');

    expect((await auth.increment('1.1.1.1')).totalHits).toBe(1);
    expect((await general.increment('1.1.1.1')).totalHits).toBe(2);
  });

  it('resetAll scans only its own scope pattern and leaves other scopes intact', async () => {
    const fake = new FakeRedis();
    const auth = new ResilientRedisStore('auth', fake);
    const general = new ResilientRedisStore('general', fake);
    auth.init(windowOptions(60_000));
    general.init(windowOptions(900_000));

    await auth.increment('1.1.1.1');
    await general.increment('2.2.2.2');
    await auth.resetAll();

    expect(fake.scans).toContain('ratelimit:auth:*');
    expect(fake.keysSnapshot()).toEqual(['ratelimit:general:2.2.2.2']);
  });
});

describe('ResilientRedisStore expiry', () => {
  it('applies the window TTL on first hit and derives resetTime from PTTL', async () => {
    const fake = new FakeRedis();
    const store = new ResilientRedisStore('auth', fake);
    store.init(windowOptions(30_000));

    const before = Date.now();
    const res = await store.increment('5.5.5.5');

    expect(res.totalHits).toBe(1);
    expect(res.resetTime).toBeInstanceOf(Date);
    expect(res.resetTime!.getTime()).toBeGreaterThanOrEqual(before + 30_000 - 50);
  });
});

describe('ResilientRedisStore failure handling', () => {
  it('falls back to in-process memory when Redis errors, without throwing', async () => {
    const fake = new FakeRedis({ failEval: true });
    const store = new ResilientRedisStore('auth', fake);
    store.init(windowOptions(60_000));

    expect((await store.increment('7.7.7.7')).totalHits).toBe(1);
    expect((await store.increment('7.7.7.7')).totalHits).toBe(2);
  });
});

describe('ResilientRedisStore decrement safety', () => {
  it('never creates a key when decrementing an absent counter', async () => {
    const fake = new FakeRedis();
    const store = new ResilientRedisStore('auth', fake);
    store.init(windowOptions(60_000));

    await store.decrement('8.8.8.8');

    expect(fake.keysSnapshot()).toEqual([]);
    expect(fake.ttlSnapshot()).toEqual([]);
  });

  it('clamps at zero on an existing counter and preserves the window TTL', async () => {
    const fake = new FakeRedis();
    const store = new ResilientRedisStore('auth', fake);
    store.init(windowOptions(60_000));

    await store.increment('8.8.8.8');
    await store.increment('8.8.8.8');
    const ttlBefore = fake.ttlSnapshot();

    await store.decrement('8.8.8.8');
    await store.decrement('8.8.8.8');
    await store.decrement('8.8.8.8');

    expect(fake.keysSnapshot()).toEqual(['ratelimit:auth:8.8.8.8']);
    expect(fake.ttlSnapshot()).toEqual(ttlBefore);
    expect((await store.increment('8.8.8.8')).totalHits).toBe(1);
  });
});

describe('createRateLimitStore', () => {
  it('returns undefined when REDIS_URL is not configured (in-memory default)', () => {
    expect(createRateLimitStore('general')).toBeUndefined();
    expect(createRateLimitStore('auth')).toBeUndefined();
    expect(createRateLimitStore('inquiry')).toBeUndefined();
    expect(createRateLimitStore('tracking')).toBeUndefined();
  });
});
