import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { createAgent, uniqueEmail } from './helpers/agent.js';
import { ADMIN_EMAIL } from './helpers/admin.js';

let app: Express;

beforeAll(() => {
  app = createApp();
});

describe('auth: register', () => {
  it('registers a new customer and sets an HttpOnly session cookie', async () => {
    const { agent, csrfToken } = await createAgent(app);
    const email = uniqueEmail('register');
    const res = await agent
      .post('/api/v1/auth/register')
      .set('X-CSRF-Token', csrfToken)
      .send({ name: 'Test User', email, password: 'supersecret1' });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.user.email).toBe(email.toLowerCase());
    expect(res.body.data.user.role).toBe('CUSTOMER');
    expect(res.body.data.user).not.toHaveProperty('passwordHash');

    const sessionCookie = (res.headers['set-cookie'] as unknown as string[]).find((c) =>
      c.startsWith('draftox_session='),
    );
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie!.toLowerCase()).toContain('httponly');
  });

  it('rejects duplicate registration with 409', async () => {
    const { agent, csrfToken } = await createAgent(app);
    const email = uniqueEmail('dupe');
    const payload = { name: 'Dupe User', email, password: 'supersecret1' };
    const first = await agent
      .post('/api/v1/auth/register')
      .set('X-CSRF-Token', csrfToken)
      .send(payload);
    expect(first.status).toBe(201);

    const second = await agent
      .post('/api/v1/auth/register')
      .set('X-CSRF-Token', csrfToken)
      .send(payload);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('CONFLICT');
  });

  it('rejects invalid email with 422', async () => {
    const { agent, csrfToken } = await createAgent(app);
    const res = await agent
      .post('/api/v1/auth/register')
      .set('X-CSRF-Token', csrfToken)
      .send({ name: 'Bad Email', email: 'not-an-email', password: 'supersecret1' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects short password with 422', async () => {
    const { agent, csrfToken } = await createAgent(app);
    const res = await agent
      .post('/api/v1/auth/register')
      .set('X-CSRF-Token', csrfToken)
      .send({ name: 'Short Pass', email: uniqueEmail('short'), password: 'abc' });
    expect(res.status).toBe(422);
  });

  it('ignores mass-assigned fields like role', async () => {
    const { agent, csrfToken } = await createAgent(app);
    const email = uniqueEmail('mass');
    const res = await agent
      .post('/api/v1/auth/register')
      .set('X-CSRF-Token', csrfToken)
      .send({ name: 'Mass User', email, password: 'supersecret1', role: 'ADMIN' });
    // .strict() schema rejects unknown keys
    expect(res.status).toBe(422);
  });

  it('refuses to register the reserved administrator email as a password account', async () => {
    const { agent, csrfToken } = await createAgent(app);
    const res = await agent
      .post('/api/v1/auth/register')
      .set('X-CSRF-Token', csrfToken)
      .send({ name: 'Impostor Admin', email: ADMIN_EMAIL, password: 'supersecret1' });

    // The reserved-admin guard runs BEFORE the duplicate-email check, so this
    // assertion is deterministic regardless of whether the admin row exists.
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
    expect(res.body.error.message).toMatch(/sign in with google/i);
  });
});

describe('auth: login / me / logout', () => {
  it('logs in with correct credentials and rejects wrong ones generically', async () => {
    const { agent, csrfToken } = await createAgent(app);
    const email = uniqueEmail('login');
    await agent.post('/api/v1/auth/register').set('X-CSRF-Token', csrfToken).send({
      name: 'Login User',
      email,
      password: 'supersecret1',
    });

    const fresh = await createAgent(app);
    const bad = await fresh.agent
      .post('/api/v1/auth/login')
      .set('X-CSRF-Token', fresh.csrfToken)
      .send({ email, password: 'wrong-password' });
    expect(bad.status).toBe(401);
    expect(bad.body.error.message).toBe('Invalid email or password');

    const ok = await fresh.agent
      .post('/api/v1/auth/login')
      .set('X-CSRF-Token', fresh.csrfToken)
      .send({ email, password: 'supersecret1' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.user.email).toBe(email.toLowerCase());

    const me = await fresh.agent.get('/api/v1/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.data.user.email).toBe(email.toLowerCase());
  });

  it('returns 401 for /me without a session', async () => {
    const res = await request(app).get('/api/v1/auth/me');
    expect(res.status).toBe(401);
  });

  it('logs out and invalidates the session', async () => {
    const { agent, csrfToken } = await createAgent(app);
    const email = uniqueEmail('logout');
    await agent.post('/api/v1/auth/register').set('X-CSRF-Token', csrfToken).send({
      name: 'Logout User',
      email,
      password: 'supersecret1',
    });

    const meBefore = await agent.get('/api/v1/auth/me');
    expect(meBefore.status).toBe(200);

    const out = await agent.post('/api/v1/auth/logout').set('X-CSRF-Token', csrfToken);
    expect(out.status).toBe(200);

    const meAfter = await agent.get('/api/v1/auth/me');
    expect(meAfter.status).toBe(401);
  });
});

describe('auth: password reset flow', () => {
  it('issues a single-use dev reset token and resets the password', async () => {
    const { agent, csrfToken } = await createAgent(app);
    const email = uniqueEmail('reset');
    const originalPassword = 'supersecret1';
    await agent.post('/api/v1/auth/register').set('X-CSRF-Token', csrfToken).send({
      name: 'Reset User',
      email,
      password: originalPassword,
    });

    const forgot = await agent
      .post('/api/v1/auth/forgot-password')
      .set('X-CSRF-Token', csrfToken)
      .send({ email });
    expect(forgot.status).toBe(200);
    expect(forgot.body.data.devToken).toBeTruthy();
    expect(forgot.body.data.message.toLowerCase()).toContain('no email was sent');

    const token = forgot.body.data.devToken as string;
    const reset = await agent.post('/api/v1/auth/reset-password').set('X-CSRF-Token', csrfToken).send({
      token,
      password: 'newpassword123',
    });
    expect(reset.status).toBe(200);

    // Old password no longer works; new one does.
    const fresh = await createAgent(app);
    const oldPass = await fresh.agent
      .post('/api/v1/auth/login')
      .set('X-CSRF-Token', fresh.csrfToken)
      .send({ email, password: originalPassword });
    expect(oldPass.status).toBe(401);

    const newPass = await fresh.agent
      .post('/api/v1/auth/login')
      .set('X-CSRF-Token', fresh.csrfToken)
      .send({ email, password: 'newpassword123' });
    expect(newPass.status).toBe(200);

    // Token cannot be reused.
    const reuse = await fresh.agent
      .post('/api/v1/auth/reset-password')
      .set('X-CSRF-Token', fresh.csrfToken)
      .send({ token, password: 'anotherpassword1' });
    expect(reuse.status).toBe(400);
  });

  it('returns a generic response for unknown emails', async () => {
    const { agent, csrfToken } = await createAgent(app);
    const res = await agent
      .post('/api/v1/auth/forgot-password')
      .set('X-CSRF-Token', csrfToken)
      .send({ email: uniqueEmail('ghost') });
    expect(res.status).toBe(200);
    expect(res.body.data.devToken).toBeUndefined();
  });
});
