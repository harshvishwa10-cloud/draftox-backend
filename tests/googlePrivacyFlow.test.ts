// Google sign-in combined with the first-time privacy preference step: after a
// successful OAuth callback the session must exist and the preferences API must
// truthfully report that NO record exists yet (so the frontend can send a new
// user to the privacy step) and never flip to "exists" until the user acts.
import './helpers/google-env.js';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Express } from 'express';
import { createAgent, type AgentWithCsrf } from './helpers/agent.js';

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

async function signInViaGoogle(agent: AgentWithCsrf['agent'], email: string) {
  (await identityMock()).mockResolvedValue({
    googleId: `g-privacy-${email}`,
    email,
    name: 'Privacy User',
    emailVerified: true,
  });
  const state = await startOAuth(agent);
  return completeOAuth(agent, state);
}

async function getPreferences(agent: AgentWithCsrf['agent']) {
  return agent.get('/api/v1/privacy/preferences').set('Accept', 'application/json');
}

describe('Google sign-in and the first-time privacy step', () => {
  it('a brand-new Google account has no preference record (exists false)', async () => {
    const { agent } = await createAgent(app);
    const email = `g-new-${Date.now()}@example.com`;

    const res = await signInViaGoogle(agent, email);
    expect(res.status).toBe(302);
    expect(res.headers.location as string).toContain(`next=${encodeURIComponent('/account')}`);

    const me = await agent.get('/api/v1/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.data.user.role).toBe('CUSTOMER');

    const prefs = await getPreferences(agent);
    expect(prefs.status).toBe(200);
    expect(prefs.body.data.preferences.exists).toBe(false);
    expect(prefs.body.data.preferences.marketingEmail).toBe(false);
    expect(prefs.body.data.preferences.updatedAt).toBeNull();
  });

  it('saving even an opt-out creates a record that is never shown as first-time again', async () => {
    const { agent, csrfToken } = await createAgent(app);
    const email = `g-saved-${Date.now()}@example.com`;

    const res = await signInViaGoogle(agent, email);
    expect(res.status).toBe(302);

    const saved = await agent
      .patch('/api/v1/privacy/preferences')
      .set('X-CSRF-Token', csrfToken)
      .send({ marketingEmail: false });
    expect(saved.status).toBe(200);
    expect(saved.body.data.preferences.exists).toBe(true);
    expect(saved.body.data.preferences.marketingEmail).toBe(false);

    const again = await agent
      .patch('/api/v1/privacy/preferences')
      .set('X-CSRF-Token', csrfToken)
      .send({ marketingEmail: false });
    expect(again.body.data.preferences.exists).toBe(true);

    const read = await getPreferences(agent);
    expect(read.body.data.preferences.exists).toBe(true);
    expect(read.body.data.preferences.marketingEmail).toBe(false);
  });

  it('keeps the Google session valid through the preference round-trip', async () => {
    const { agent, csrfToken } = await createAgent(app);
    const email = `g-round-${Date.now()}@example.com`;

    const res = await signInViaGoogle(agent, email);
    expect(res.status).toBe(302);

    expect(await getPreferences(agent)).toSatisfy((r: { status: number }) => r.status === 200);
    const saved = await agent
      .patch('/api/v1/privacy/preferences')
      .set('X-CSRF-Token', csrfToken)
      .send({ marketingEmail: true });
    expect(saved.status).toBe(200);

    const me = await agent.get('/api/v1/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.data.user.role).toBe('CUSTOMER');
  });
});