import { beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeRedisClient {
  store: Map<string, string>;
  ttls: Map<string, number>;
  status: string;
}

// Captured so tests can inspect the exact keys/TTLs the cache module wrote,
// WITHOUT requiring a real Redis.
const { lastClient } = vi.hoisted(() => ({
  lastClient: { current: null as FakeRedisClient | null },
}));

vi.mock('ioredis', () => {
  class FakeRedis {
    store = new Map<string, string>();
    ttls = new Map<string, number>();
    status = 'ready';

    constructor() {
      lastClient.current = this as unknown as FakeRedisClient;
    }

    on(): this {
      return this;
    }
    once(): this {
      return this;
    }
    off(): this {
      return this;
    }

    async get(key: string): Promise<string | null> {
      return this.store.get(key) ?? null;
    }

    async set(key: string, value: string, _mode: string, ttl: number): Promise<'OK'> {
      this.store.set(key, value);
      this.ttls.set(key, ttl);
      return 'OK';
    }

    async scan(
      _cursor: string,
      _match: string,
      pattern: string,
      _count: string,
      _n: number,
    ): Promise<[string, string[]]> {
      const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
      const re = new RegExp(`^${escaped}$`);
      return ['0', [...this.store.keys()].filter((key) => re.test(key))];
    }

    async del(...keys: string[]): Promise<number> {
      let removed = 0;
      for (const key of keys) {
        if (this.store.delete(key)) removed += 1;
        this.ttls.delete(key);
      }
      return removed;
    }

    async quit(): Promise<'OK'> {
      this.status = 'end';
      return 'OK';
    }

    disconnect(): void {
      this.status = 'end';
    }
  }

  return { Redis: FakeRedis, default: FakeRedis };
});

// Force the cache to be "configured" so the module builds a client (real env
// has REDIS_URL='' during tests, which would make every call a no-op).
vi.mock('../src/config/env.js', () => ({
  env: { REDIS_URL: 'redis://fake:6379', CACHE_TTL_SECONDS: 60 },
}));

import { cacheGet, cacheSet, closeCache, invalidateCatalog } from '../src/lib/cache.js';

function current(): FakeRedisClient {
  if (!lastClient.current) throw new Error('fake Redis client was not created');
  return lastClient.current;
}

describe('cache module (mocked Redis, no real server required)', () => {
  beforeEach(async () => {
    // Reset the module-level singleton so each test starts from a fresh client.
    await closeCache();
    lastClient.current = null;
  });

  it('writes list entries under the catalog: prefix with the given TTL', async () => {
    await cacheSet('products:list:1:12:', { items: [], meta: {} }, 7);

    const client = current();
    expect([...client.store.keys()]).toEqual(['catalog:products:list:1:12:']);
    expect(client.ttls.get('catalog:products:list:1:12:')).toBe(7);
  });

  it('falls back to the configured default TTL when none is passed', async () => {
    await cacheSet('products:slug:abc', { product: { slug: 'abc' } });
    expect(current().ttls.get('catalog:products:slug:abc')).toBe(60);
  });

  it('round-trips a value (hit) and returns null on a miss', async () => {
    await cacheSet('products:slug:abc', { product: { slug: 'abc' } });
    expect(await cacheGet('products:slug:abc')).toEqual({ product: { slug: 'abc' } });
    expect(await cacheGet('products:slug:missing')).toBeNull();
  });

  it('invalidateCatalog drops catalog: keys but leaves unrelated keys intact', async () => {
    await cacheSet('products:list:1:12:', { items: [] });
    await cacheSet('products:slug:abc', { product: {} });

    const client = current();
    // An unrelated key that must survive a catalogue invalidation.
    client.store.set('ratelimit:general:1.2.3.4', '5');

    await invalidateCatalog();

    expect(client.store.has('catalog:products:list:1:12:')).toBe(false);
    expect(client.store.has('catalog:products:slug:abc')).toBe(false);
    expect(client.store.has('ratelimit:general:1.2.3.4')).toBe(true);
    expect(await cacheGet('products:slug:abc')).toBeNull();
  });
});
