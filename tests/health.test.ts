import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';

/**
 * Control the cache probe deterministically (no real Redis in tests). The mock
 * must expose every symbol the app imports from the cache module.
 */
const { probeCache } = vi.hoisted(() => ({ probeCache: vi.fn() }));

vi.mock('../src/lib/cache.js', () => ({
  probeCache,
  cacheStatus: vi.fn(() => 'disabled'),
  isCacheConfigured: vi.fn(() => false),
  cacheGet: vi.fn(async () => null),
  cacheSet: vi.fn(async () => undefined),
  invalidateCatalog: vi.fn(async () => undefined),
  closeCache: vi.fn(async () => undefined),
  sanitizeRedisError: vi.fn((e: unknown) => String(e)),
}));

import { createApp } from '../src/app.js';

let app: Express;

beforeAll(() => {
  app = createApp();
});

beforeEach(() => {
  probeCache.mockReset();
});

describe('GET /api/v1/health cache reporting', () => {
  it('reports cache connected (no error) when the probe succeeds', async () => {
    probeCache.mockResolvedValue({ status: 'connected', error: null });

    const res = await request(app).get('/api/v1/health');

    expect(res.status).toBe(200);
    expect(res.body.data.database).toBe('connected');
    expect(res.body.data.cache).toBe('connected');
    expect(res.body.data.cacheError).toBeNull();
  });

  it('reports cache unavailable with the credential-free error', async () => {
    probeCache.mockResolvedValue({
      status: 'unavailable',
      error: 'connect ECONNREFUSED 127.0.0.1:6379',
    });

    const res = await request(app).get('/api/v1/health');

    expect(res.body.data.cache).toBe('unavailable');
    expect(res.body.data.cacheError).toBe('connect ECONNREFUSED 127.0.0.1:6379');
  });

  it('reports cache disabled when Redis is not configured', async () => {
    probeCache.mockResolvedValue({ status: 'disabled', error: null });

    const res = await request(app).get('/api/v1/health');

    expect(res.body.data.cache).toBe('disabled');
    expect(res.body.data.cacheError).toBeNull();
  });

  it('keeps the HTTP status driven by the database, not the cache', async () => {
    probeCache.mockResolvedValue({ status: 'unavailable', error: 'down' });

    const res = await request(app).get('/api/v1/health');

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('ok');
  });
});
