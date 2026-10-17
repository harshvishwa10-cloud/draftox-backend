import { describe, expect, it } from 'vitest';
import { probeRedis, sanitizeRedisError, type ProbeRedisClient } from '../src/lib/cache.js';

/**
 * Minimal fake ioredis client covering only what the probe touches, so the
 * connection logic is exercised WITHOUT requiring a real Redis.
 */
class FakeProbeClient implements ProbeRedisClient {
  status: string;
  private readonly pong: string;
  private readonly pingError: Error | null;
  private readonly listeners = new Set<() => void>();

  constructor(
    opts: { status?: string; pong?: string; pingError?: Error; readyAfterMs?: number } = {},
  ) {
    this.status = opts.status ?? 'ready';
    this.pong = opts.pong ?? 'PONG';
    this.pingError = opts.pingError ?? null;
    if (this.status !== 'ready' && opts.readyAfterMs !== undefined) {
      setTimeout(() => {
        this.status = 'ready';
        for (const listener of this.listeners) listener();
      }, opts.readyAfterMs);
    }
  }

  async ping(): Promise<string> {
    if (this.pingError) throw this.pingError;
    return this.pong;
  }

  once(_event: 'ready', listener: () => void): unknown {
    this.listeners.add(listener);
    return this;
  }

  off(_event: 'ready', listener: () => void): unknown {
    this.listeners.delete(listener);
    return this;
  }
}

describe('sanitizeRedisError', () => {
  it('redacts credentials embedded in a Redis URL', () => {
    const out = sanitizeRedisError(new Error('Connection to redis://:s3cr3t@127.0.0.1:6379 failed'));
    expect(out).not.toContain('s3cr3t');
    expect(out).toContain('redis://***@127.0.0.1:6379');
  });

  it('passes a credential-free connection error through unchanged', () => {
    expect(sanitizeRedisError(new Error('connect ECONNREFUSED 127.0.0.1:6379'))).toBe(
      'connect ECONNREFUSED 127.0.0.1:6379',
    );
  });
});

describe('probeRedis', () => {
  it('reports connected when PING returns PONG on a ready client', async () => {
    const res = await probeRedis(new FakeProbeClient({ status: 'ready' }), () => null);
    expect(res).toEqual({ status: 'connected', error: null });
  });

  it('waits for readiness, then reports connected (fixes the idle false-negative)', async () => {
    const res = await probeRedis(
      new FakeProbeClient({ status: 'connecting', readyAfterMs: 20 }),
      () => null,
      1000,
    );
    expect(res).toEqual({ status: 'connected', error: null });
  });

  it('reports the last real error (read after the wait) when it never becomes ready', async () => {
    // Simulates the error arriving DURING the wait: the getter only returns it later.
    let currentError: string | null = null;
    setTimeout(() => {
      currentError = 'connect ECONNREFUSED 127.0.0.1:6379';
    }, 10);

    const res = await probeRedis(new FakeProbeClient({ status: 'reconnecting' }), () => currentError, 60);
    expect(res).toEqual({ status: 'unavailable', error: 'connect ECONNREFUSED 127.0.0.1:6379' });
  });

  it('falls back to a generic timeout when no error was observed', async () => {
    const res = await probeRedis(new FakeProbeClient({ status: 'reconnecting' }), () => null, 30);
    expect(res).toEqual({ status: 'unavailable', error: 'connection_timeout' });
  });

  it('reports a credential-free error when PING itself fails', async () => {
    const res = await probeRedis(
      new FakeProbeClient({ status: 'ready', pingError: new Error('redis://:pw@host:6379 boom') }),
      () => null,
    );
    expect(res.status).toBe('unavailable');
    expect(res.error).not.toContain('pw@');
    expect(res.error).toContain('redis://***@host:6379');
  });

  it('flags an unexpected PING reply', async () => {
    const res = await probeRedis(
      new FakeProbeClient({ status: 'ready', pong: 'nonsense' }),
      () => null,
    );
    expect(res).toEqual({ status: 'unavailable', error: 'unexpected_ping_reply' });
  });
});
