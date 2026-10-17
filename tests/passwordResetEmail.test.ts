import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Express } from 'express';

// Controllable mailer mock: no real SMTP is ever contacted. The password-reset
// service must send the reset link through this mailer and must never leak the
// token back in the HTTP response.
const mailer = vi.hoisted(() => ({ sendMail: vi.fn(), isReady: true }));

vi.mock('../src/lib/mailer.js', () => ({
  get isMailerReady() {
    return mailer.isReady;
  },
  sendMail: (input: unknown) => mailer.sendMail(input),
}));

const SUPPORT_EMAIL = 'draftoxcustomersupport@gmail.com';

interface SentMail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

describe('auth: password reset email delivery (SMTP configured)', () => {
  let app: Express;
  let createAgent: typeof import('./helpers/agent.js').createAgent;
  let uniqueEmail: typeof import('./helpers/agent.js').uniqueEmail;

  beforeEach(async () => {
    vi.resetModules();
    process.env.EMAIL_PROVIDER = 'smtp';
    process.env.SMTP_HOST = 'smtp.gmail.com';
    process.env.SMTP_PORT = '465';
    process.env.SMTP_USER = SUPPORT_EMAIL;
    process.env.SMTP_PASS = 'test-app-password-0000';

    mailer.sendMail.mockReset();
    mailer.isReady = true;
    mailer.sendMail.mockResolvedValue({ accepted: true, messageId: 'mid-1', error: null });

    const appMod = await import('../src/app.js');
    app = appMod.createApp();
    const agentMod = await import('./helpers/agent.js');
    createAgent = agentMod.createAgent;
    uniqueEmail = agentMod.uniqueEmail;
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  async function registerAndForgot(email: string) {
    const { agent, csrfToken } = await createAgent(app);
    await agent
      .post('/api/v1/auth/register')
      .set('X-CSRF-Token', csrfToken)
      .send({ name: 'Reset Mail', email, password: 'supersecret1' });
    return agent
      .post('/api/v1/auth/forgot-password')
      .set('X-CSRF-Token', csrfToken)
      .send({ email });
  }

  it('emails a reset link and does not expose the token in the response', async () => {
    const email = uniqueEmail('resetmail');
    const res = await registerAndForgot(email);

    expect(res.status).toBe(200);
    expect(res.body.data.devToken).toBeUndefined();

    const sent = mailer.sendMail.mock.calls
      .map((call) => call[0] as SentMail)
      .find((mail) => mail.to === email);
    expect(sent).toBeTruthy();
    expect(sent!.subject.toLowerCase()).toContain('reset');
    expect(sent!.html).toContain('/reset-password?token=');
    expect(sent!.text).toContain('/reset-password?token=');
  });

  it('returns a generic response without throwing when delivery is rejected', async () => {
    mailer.sendMail.mockResolvedValue({ accepted: false, messageId: null, error: 'smtp down' });

    const email = uniqueEmail('resetfail');
    const res = await registerAndForgot(email);

    expect(res.status).toBe(200);
    expect(res.body.data.devToken).toBeUndefined();
    const attempted = mailer.sendMail.mock.calls.some(
      (call) => (call[0] as SentMail).to === email,
    );
    expect(attempted).toBe(true);
  });
});
