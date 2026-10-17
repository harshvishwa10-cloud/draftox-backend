import { beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { createAgent, uniqueEmail, type AgentWithCsrf } from './helpers/agent.js';

let app: Express;

beforeAll(async () => {
  const mod = await import('../src/app.js');
  app = mod.createApp();
});

interface AuthedAgent extends AgentWithCsrf {
  email: string;
}

async function registerAgent(): Promise<AuthedAgent> {
  const { agent, csrfToken } = await createAgent(app);
  const email = uniqueEmail('consent');
  const res = await agent
    .post('/api/v1/auth/register')
    .set('X-CSRF-Token', csrfToken)
    .send({ name: 'Consent Person', email, password: 'testpassword1' });
  expect(res.status).toBe(201);
  return { agent, csrfToken, email };
}

function patchPreferences(agent: AuthedAgent, marketingEmail: boolean) {
  return agent.agent
    .patch('/api/v1/privacy/preferences')
    .set('X-CSRF-Token', agent.csrfToken)
    .send({ marketingEmail });
}

describe('privacy consent preferences', () => {
  it('requires authentication for GET and PATCH', async () => {
    const anon = await createAgent(app);
    const getRes = await anon.agent.get('/api/v1/privacy/preferences');
    expect(getRes.status).toBe(401);

    const patchRes = await anon.agent
      .patch('/api/v1/privacy/preferences')
      .set('X-CSRF-Token', anon.csrfToken)
      .send({ marketingEmail: true });
    expect(patchRes.status).toBe(401);
  });

  it('defaults to opt-out (marketingEmail false) before any consent is given', async () => {
    const user = await registerAgent();

    const res = await user.agent
      .get('/api/v1/privacy/preferences')
      .set('X-CSRF-Token', user.csrfToken);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.preferences.marketingEmail).toBe(false);
    expect(res.body.data.preferences.updatedAt).toBeNull();
    expect(res.body.data.preferences.exists).toBe(false);
  });

  it('rejects a non-boolean marketingEmail with 422', async () => {
    const user = await registerAgent();

    const res = await user.agent
      .patch('/api/v1/privacy/preferences')
      .set('X-CSRF-Token', user.csrfToken)
      .send({ marketingEmail: 'yes' });
    expect(res.status).toBe(422);
  });

  it('persists an opt-in and an opt-out, with updatedAt stamped', async () => {
    const user = await registerAgent();

    const on = await patchPreferences(user, true);
    expect(on.status).toBe(200);
    expect(on.body.data.preferences.marketingEmail).toBe(true);
    expect(on.body.data.preferences.updatedAt).toBeTypeOf('string');
    expect(on.body.data.preferences.exists).toBe(true);

    const read = await user.agent
      .get('/api/v1/privacy/preferences')
      .set('X-CSRF-Token', user.csrfToken);
    expect(read.status).toBe(200);
    expect(read.body.data.preferences.marketingEmail).toBe(true);
    expect(read.body.data.preferences.exists).toBe(true);

    const off = await patchPreferences(user, false);
    expect(off.status).toBe(200);
    expect(off.body.data.preferences.marketingEmail).toBe(false);
    // An explicit opt-out is still a stored record — it must not be mistaken
    // for the "never answered" first-time state.
    expect(off.body.data.preferences.exists).toBe(true);

    const readOff = await user.agent
      .get('/api/v1/privacy/preferences')
      .set('X-CSRF-Token', user.csrfToken);
    expect(readOff.body.data.preferences.exists).toBe(true);
    expect(readOff.body.data.preferences.marketingEmail).toBe(false);
  });

  it('scopes preferences per user — one account never sees anothers consent', async () => {
    const userA = await registerAgent();
    await patchPreferences(userA, true);

    const userB = await registerAgent();
    const resB = await userB.agent
      .get('/api/v1/privacy/preferences')
      .set('X-CSRF-Token', userB.csrfToken);
    expect(resB.body.data.preferences.marketingEmail).toBe(false);
    expect(resB.body.data.preferences.exists).toBe(false);
  });
});