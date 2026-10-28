// Enables Google OAuth config and mocks the identity verifier so the real
// callback route runs without contacting Google.
import './helpers/google-env.js';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Express } from 'express';
import { createAgent, type AgentWithCsrf } from './helpers/agent.js';
import { ADMIN_EMAIL, SUPPORT_EMAIL } from './helpers/admin.js';

vi.mock('../src/modules/auth/google.service.js', () => ({
  getGoogleAuthUrl: () => 'https://accounts.google.com/o/oauth2/v2/auth?mock=1',
  verifyGoogleCode: vi.fn(),
}));

let app: Express;

beforeAll(async () => {
  const mod = await import('../src/app.js');
  app = mod.createApp();
});

function cookieValue(setCookie: unknown, name: string): string | null {
  const arr = Array.isArray(setCookie)
    ? setCookie
    : setCookie
      ? [setCookie as string]
      : [];
  const found = arr.find((c) => (c as string).startsWith(`${name}=`));
  if (!found) return null;
  return decodeURIComponent((found as string).split(';')[0].split('=')[1]);
}

async function startOAuth(agent: AgentWithCsrf['agent']): Promise<string> {
  const res = await agent.get('/api/v1/auth/google');
  expect(res.status).toBe(302);
  const state = cookieValue(res.headers['set-cookie'], 'draftox_oauth_state');
  expect(state).toBeTruthy();
  return state as string;
}

function completeOAuth(
  agent: AgentWithCsrf['agent'],
  state: string,
): ReturnType<AgentWithCsrf['agent']['get']> {
  return agent
    .get(`/api/v1/auth/google/callback?code=test-code&state=${encodeURIComponent(state)}`)
    .set('Accept', 'text/html');
}

async function identityMock() {
  const gs = await import('../src/modules/auth/google.service.js');
  return vi.mocked(gs.verifyGoogleCode);
}

describe('Google OAuth admin authorization', () => {
  it('grants admin to a verified draftox0@gmail.com and redirects to the dashboard', async () => {
    (await identityMock()).mockResolvedValue({
      googleId: 'g-admin-owner',
      email: ADMIN_EMAIL,
      name: 'DRAFTOX Owner',
      emailVerified: true,
    });

    const { agent } = await createAgent(app);
    const state = await startOAuth(agent);
    const res = await completeOAuth(agent, state);

    expect(res.status).toBe(302);
    const location = res.headers.location as string;
    expect(location).toContain('/auth/callback?status=success');
    expect(location).toContain(`next=${encodeURIComponent('/admin/orders')}`);

    const me = await agent.get('/api/v1/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.data.user.role).toBe('ADMIN');
    expect((await agent.get('/api/v1/admin/orders')).status).toBe(200);
  });

  it('keeps every other verified Google account as an ordinary customer', async () => {
    const email = `customer-${Date.now()}@example.com`;
    (await identityMock()).mockResolvedValue({
      googleId: `g-customer-${Date.now()}`,
      email,
      name: 'Ordinary Customer',
      emailVerified: true,
    });

    const { agent } = await createAgent(app);
    const state = await startOAuth(agent);
    const res = await completeOAuth(agent, state);

    expect(res.status).toBe(302);
    expect(res.headers.location as string).toContain(`next=${encodeURIComponent('/account')}`);

    const me = await agent.get('/api/v1/auth/me');
    expect(me.body.data.user.role).toBe('CUSTOMER');
    expect((await agent.get('/api/v1/admin/orders')).status).toBe(403);
  });

  it('keeps the verified support account as a RESTRICTED support account, not an admin', async () => {
    // draftoxcustomersupport@gmail.com is a restricted support account
    // (configured in SUPPORT_EMAILS), NOT an administrator: with a
    // Google-VERIFIED email it signs in as CUSTOMER and may reach ONLY the
    // public-request inbox.
    (await identityMock()).mockResolvedValue({
      googleId: 'g-support-sender',
      email: SUPPORT_EMAIL,
      name: 'DRAFTOX Support',
      emailVerified: true,
    });

    const { agent } = await createAgent(app);
    const state = await startOAuth(agent);
    const res = await completeOAuth(agent, state);

    expect(res.status).toBe(302);
    const location = res.headers.location as string;
    expect(location).toContain('/auth/callback?status=success');
    // Not an admin, so no admin dashboard redirect.
    expect(location).toContain(`next=${encodeURIComponent('/account')}`);

    const me = await agent.get('/api/v1/auth/me');
    expect(me.body.data.user.role).toBe('CUSTOMER');
    // Denied every full-admin route...
    expect((await agent.get('/api/v1/admin/orders')).status).toBe(403);
    // ...but allowed the restricted public-request inbox.
    expect((await agent.get('/api/v1/admin/inquiries/contact')).status).toBe(200);
  });

  it('never grants admin to a support account whose email is not verified', async () => {
    const { ApiError } = await import('../src/utils/ApiError.js');
    // Google refusing to confirm the email must never yield admin, even for an
    // address that would otherwise be authorized.
    (await identityMock()).mockRejectedValue(
      ApiError.forbidden('Google account email is not verified'),
    );

    const { agent } = await createAgent(app);
    const state = await startOAuth(agent);
    const res = await completeOAuth(agent, state);

    expect(res.status).toBe(302);
    expect(res.headers.location as string).toContain('status=error');
    expect((await agent.get('/api/v1/auth/me')).status).toBe(401);
  });

  it('never grants admin when Google does not provide a verified email', async () => {
    const { ApiError } = await import('../src/utils/ApiError.js');
    (await identityMock()).mockRejectedValue(
      ApiError.forbidden('Google account email is not verified'),
    );

    const { agent } = await createAgent(app);
    const state = await startOAuth(agent);
    const res = await completeOAuth(agent, state);

    expect(res.status).toBe(302);
    expect(res.headers.location as string).toContain('status=error');
    // No session was created — the failed sign-in cannot reach any protected API.
    expect((await agent.get('/api/v1/auth/me')).status).toBe(401);
  });

  it('still supports ordinary email registration and login (customer path)', async () => {
    const { agent, csrfToken } = await createAgent(app);
    const email = `plain-${Date.now()}@example.com`;

    const reg = await agent
      .post('/api/v1/auth/register')
      .set('X-CSRF-Token', csrfToken)
      .send({ name: 'Plain Customer', email, password: 'plainpassword1' });
    expect(reg.status).toBe(201);
    expect(reg.body.data.user.role).toBe('CUSTOMER');

    const login = await agent
      .post('/api/v1/auth/login')
      .set('X-CSRF-Token', csrfToken)
      .send({ email, password: 'plainpassword1' });
    expect(login.status).toBe(200);
    expect(login.body.data.user.role).toBe('CUSTOMER');
  });
});
