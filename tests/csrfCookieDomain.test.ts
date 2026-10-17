// Phase 1 — Cloudflare migration: the CSRF cookie may carry a Domain attribute.
//
// Behaviour under test:
//   * COOKIE_DOMAIN configured  -> draftox_csrf gets `Domain=<value>`.
//   * COOKIE_DOMAIN unset/empty -> draftox_csrf has NO Domain attribute.
//   * The HttpOnly session / Firebase-session / OAuth-state cookies never get a
//     Domain, even when COOKIE_DOMAIN is configured.
//   * Invalid COOKIE_DOMAIN values are rejected by the env schema.
//
// The env-dependent cases use the repo's established pattern: mutate process.env
// then `vi.resetModules()` before a dynamic import so src/config/env.ts is
// evaluated with the intended value.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';

interface CapturedCookie {
  name: string;
  value: string;
  options: Record<string, unknown>;
}

function captureResponse(): { res: Response; cookies: CapturedCookie[] } {
  const cookies: CapturedCookie[] = [];
  const res = {
    cookie(name: string, value: string, options: Record<string, unknown>) {
      cookies.push({ name, value, options });
      return res;
    },
  };
  return { res: res as unknown as Response, cookies };
}

const VALID_BASE_ENV = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/draftox_backend_test',
  FRONTEND_URL: 'http://localhost:3000',
  CORS_ORIGINS: 'http://localhost:3000',
  SESSION_SECRET: 'x'.repeat(32),
};

afterEach(() => {
  vi.resetModules();
  process.env.COOKIE_DOMAIN = '';
});

describe('CSRF cookie Domain attribute', () => {
  it('omits the Domain attribute when COOKIE_DOMAIN is unset', async () => {
    process.env.COOKIE_DOMAIN = '';
    vi.resetModules();
    const { ensureCsrfCookie, CSRF_COOKIE } = await import('../src/utils/cookies.js');

    const { res, cookies } = captureResponse();
    ensureCsrfCookie(res);

    expect(CSRF_COOKIE).toBe('draftox_csrf');
    expect(cookies).toHaveLength(1);
    expect(cookies[0].name).toBe('draftox_csrf');
    expect(cookies[0].options).not.toHaveProperty('domain');
  });

  it('applies the configured Domain to the draftox_csrf cookie', async () => {
    process.env.COOKIE_DOMAIN = '.draftox.in';
    vi.resetModules();
    const { ensureCsrfCookie } = await import('../src/utils/cookies.js');

    const { res, cookies } = captureResponse();
    ensureCsrfCookie(res);

    expect(cookies).toHaveLength(1);
    expect(cookies[0].name).toBe('draftox_csrf');
    expect(cookies[0].options.domain).toBe('.draftox.in');
    // Still a valid frontend-readable double-submit cookie.
    expect(cookies[0].options.httpOnly).toBe(false);
    expect(cookies[0].options.sameSite).toBe('lax');
    expect(cookies[0].options.path).toBe('/');
  });

  it('never adds a Domain to the session, Firebase-session, or OAuth-state cookies', async () => {
    process.env.COOKIE_DOMAIN = '.draftox.in';
    vi.resetModules();
    const c = await import('../src/utils/cookies.js');

    const { res, cookies } = captureResponse();
    c.setSessionCookie(res, 'session-token', 60_000);
    c.setFirebaseSessionCookie(res, 'firebase-token', 60_000);
    c.setOAuthStateCookie(res, 'oauth-state');

    expect(cookies.map((x) => x.name)).toEqual([
      c.SESSION_COOKIE,
      c.FIREBASE_SESSION_COOKIE,
      c.OAUTH_STATE_COOKIE,
    ]);
    for (const cookie of cookies) {
      expect(cookie.options).not.toHaveProperty('domain');
      expect(cookie.options.httpOnly).toBe(true);
    }
  });
});

describe('COOKIE_DOMAIN configuration validation', () => {
  async function parseCookieDomain(value: string | undefined) {
    vi.resetModules();
    const { EnvSchema } = await import('../src/config/env.js');
    return EnvSchema.safeParse({ ...VALID_BASE_ENV, COOKIE_DOMAIN: value });
  }

  it('accepts a bare leading-dot domain, an empty string, and undefined', async () => {
    const domain = await parseCookieDomain('.draftox.in');
    expect(domain.success).toBe(true);
    if (domain.success) expect(domain.data.COOKIE_DOMAIN).toBe('.draftox.in');

    expect((await parseCookieDomain('.draftox.co.in')).success).toBe(true);

    const empty = await parseCookieDomain('');
    expect(empty.success).toBe(true);
    // Empty is treated as unset so behaviour matches a missing variable.
    if (empty.success) expect(empty.data.COOKIE_DOMAIN).toBeUndefined();

    const absent = await parseCookieDomain(undefined);
    expect(absent.success).toBe(true);
    if (absent.success) expect(absent.data.COOKIE_DOMAIN).toBeUndefined();
  });

  it('rejects protocols, paths, ports, whitespace, and malformed domains', async () => {
    const invalid = [
      'draftox.in', // no leading dot
      'https://draftox.in', // protocol
      '.draftox.in/', // path
      '.draftox.in:3000', // port
      '.draftox.in ', // trailing whitespace
      ' .draftox.in', // leading whitespace
      '.draftox .in', // internal whitespace
      '.draftox', // missing TLD
      '.', // empty label
      '..draftox.in', // empty label
      '.-draftox.in', // label starts with hyphen
      '.draftox-.in', // label ends with hyphen
      '.draftox.in\n', // trailing newline
    ];

    for (const value of invalid) {
      const result = await parseCookieDomain(value);
      expect(result.success, `expected ${JSON.stringify(value)} to be rejected`).toBe(false);
    }
  });
});
