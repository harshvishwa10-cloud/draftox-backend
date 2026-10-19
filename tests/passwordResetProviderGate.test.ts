// H1 regression: the password-reset email gate must use the authoritative
// mailer-readiness signal (Brevo HTTP API OR SMTP), NOT the stale
// `EMAIL_PROVIDER === 'none'` value, and it must never return a reset token to
// a client outside the automated test suite.
//
// NOTE: './helpers/brevo-env.js' MUST stay the first import — it sets
// BREVO_API_KEY (while leaving EMAIL_PROVIDER=none) BEFORE src/config/env.ts is
// first evaluated, reproducing the exact Brevo-only deployment shape that the
// old check mishandled.
import './helpers/brevo-env.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Express } from 'express';

const BREVO_URL = 'https://api.brevo.com/v3/smtp/email';

async function importApp(): Promise<Express> {
  const mod = await import('../src/app.js');
  return mod.createApp();
}

describe('password reset provider gate (H1)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('sends the reset email when Brevo is configured but EMAIL_PROVIDER=none, and returns no token', async () => {
    process.env.NODE_ENV = 'test';
    process.env.EMAIL_PROVIDER = 'none';
    process.env.BREVO_API_KEY = 'xkeysib-test-do-not-log-contact-0001';
    process.env.SMTP_HOST = '';
    process.env.SMTP_USER = '';
    process.env.SMTP_PASS = '';
    vi.resetModules();

    // The stale variable is still 'none', yet the mailer is genuinely ready.
    expect(process.env.EMAIL_PROVIDER).toBe('none');
    const { isMailerReady } = await import('../src/lib/mailer.js');
    expect(isMailerReady).toBe(true);

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ messageId: 'brevo-reset-mid-1' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const app = await importApp();
    const { createAgent, uniqueEmail } = await import('./helpers/agent.js');
    const { agent, csrfToken } = await createAgent(app);
    const email = uniqueEmail('reset-brevo');

    await agent
      .post('/api/v1/auth/register')
      .set('X-CSRF-Token', csrfToken)
      .send({ name: 'Brevo Reset', email, password: 'supersecret1' });

    const res = await agent
      .post('/api/v1/auth/forgot-password')
      .set('X-CSRF-Token', csrfToken)
      .send({ email });

    expect(res.status).toBe(200);
    expect(res.body.data.devToken).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('token=');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(url).toBe(BREVO_URL);
    const payload = JSON.parse(init.body) as {
      to: Array<{ email: string }>;
      htmlContent: string;
      textContent: string;
    };
    expect(payload.to).toEqual([{ email }]);
    expect(payload.htmlContent).toContain('/reset-password?token=');
    expect(payload.textContent).toContain('/reset-password?token=');
  });

  it('returns a generic 503 and no token when the mailer is not configured (development)', async () => {
    process.env.NODE_ENV = 'development';
    process.env.EMAIL_PROVIDER = 'none';
    process.env.BREVO_API_KEY = '';
    process.env.SMTP_HOST = '';
    process.env.SMTP_USER = '';
    process.env.SMTP_PASS = '';
    vi.resetModules();

    const { isMailerReady } = await import('../src/lib/mailer.js');
    expect(isMailerReady).toBe(false);

    const app = await importApp();
    const { createAgent, uniqueEmail } = await import('./helpers/agent.js');
    const { agent, csrfToken } = await createAgent(app);
    const email = uniqueEmail('reset-dev-nomail');

    await agent
      .post('/api/v1/auth/register')
      .set('X-CSRF-Token', csrfToken)
      .send({ name: 'Dev No Mail', email, password: 'supersecret1' });

    const res = await agent
      .post('/api/v1/auth/forgot-password')
      .set('X-CSRF-Token', csrfToken)
      .send({ email });

    expect(res.status).toBe(503);
    expect(res.body.error?.code).toBe('SERVICE_UNAVAILABLE');
    expect(res.body.data?.devToken).toBeUndefined();
    // No reset token, link, or URL may appear anywhere in the response.
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain('devToken');
    expect(serialized).not.toContain('token=');
    expect(serialized).not.toContain('reset-password');
  });

  it('never returns a reset token in production when the mailer is not configured', async () => {
    process.env.NODE_ENV = 'production';
    process.env.EMAIL_PROVIDER = 'none';
    process.env.BREVO_API_KEY = '';
    process.env.SMTP_HOST = '';
    process.env.SMTP_USER = '';
    process.env.SMTP_PASS = '';
    vi.resetModules();

    const { isMailerReady } = await import('../src/lib/mailer.js');
    expect(isMailerReady).toBe(false);

    const { prisma } = await import('../src/lib/prisma.js');
    const { uniqueEmail } = await import('./helpers/agent.js');
    const { forgotPassword } = await import('../src/modules/auth/auth.service.js');

    const email = uniqueEmail('reset-prod-nomail');
    await prisma.user.create({ data: { name: 'Prod No Mail', email, role: 'CUSTOMER' } });

    try {
      let caught: unknown;
      try {
        await forgotPassword({ email });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeDefined();
      expect(caught).toMatchObject({
        name: 'ApiError',
        statusCode: 503,
        code: 'SERVICE_UNAVAILABLE',
      });
      expect(caught).not.toHaveProperty('devToken');
      const serialized = JSON.stringify(caught, Object.getOwnPropertyNames(caught as object));
      expect(serialized).not.toContain('token=');
      expect(serialized).not.toContain('reset-password');
    } finally {
      await prisma.user.deleteMany({ where: { email } });
    }
  });
});
