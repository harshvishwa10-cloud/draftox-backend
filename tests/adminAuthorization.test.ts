// Server-enforced, multi-admin authorization policy. Covers the two official
// DRAFTOX accounts (ADMIN_EMAIL + the support account in ADMIN_EMAILS), the
// verified-email requirement, unrelated-customer denial, forged client
// claims/roles, exact-match (no domain wildcard) matching, and both the legacy
// session and Firebase authentication paths.
import { beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { createAgent, uniqueEmail, type AgentWithCsrf } from './helpers/agent.js';
import {
  ADMIN_EMAIL,
  SUPPORT_EMAIL,
  SUPPORT_ADMIN_PASSWORD,
  ensureAdminUser,
  getAdminAgent,
  getSupportAdminAgent,
  loginAgent,
} from './helpers/admin.js';

describe('authorized-admin email set', () => {
  it('includes exactly the two official accounts (ADMIN_EMAIL + ADMIN_EMAILS)', async () => {
    const { AUTHORIZED_ADMIN_EMAILS } = await import('../src/modules/auth/authorization.js');
    expect(AUTHORIZED_ADMIN_EMAILS).toContain(ADMIN_EMAIL);
    expect(AUTHORIZED_ADMIN_EMAILS).toContain(SUPPORT_EMAIL);
    expect(AUTHORIZED_ADMIN_EMAILS).toHaveLength(2);
  });

  it('matches the configured addresses case-insensitively', async () => {
    const { isAuthorizedAdminEmail } = await import('../src/modules/auth/authorization.js');
    expect(isAuthorizedAdminEmail(ADMIN_EMAIL)).toBe(true);
    expect(isAuthorizedAdminEmail(SUPPORT_EMAIL)).toBe(true);
    expect(isAuthorizedAdminEmail(ADMIN_EMAIL.toUpperCase())).toBe(true);
    expect(isAuthorizedAdminEmail(`  ${SUPPORT_EMAIL}  `)).toBe(true);
    expect(isAuthorizedAdminEmail('')).toBe(false);
    expect(isAuthorizedAdminEmail(null)).toBe(false);
    expect(isAuthorizedAdminEmail(undefined)).toBe(false);
  });

  it('never authorizes lookalike addresses (exact match, no domain wildcard)', async () => {
    const { isAuthorizedAdminEmail } = await import('../src/modules/auth/authorization.js');
    const lookalikes = [
      'notdraftox0@gmail.com',
      'draftox0@gmail.com.evil.com',
      'draftox0+alias@gmail.com',
      'draftox0@gmail.co',
      'admin@draftox.com',
      'draftoxcustomersupport@gmail.com.attacker.net',
      'someone@draftoxcustomersupport.com',
      'draftoxcustomersupport@outlook.com',
      'support@draftox.in',
    ];
    for (const email of lookalikes) {
      expect(isAuthorizedAdminEmail(email), email).toBe(false);
    }
  });

  it('requires BOTH an authorized email and a verified email', async () => {
    const { effectiveRole } = await import('../src/modules/auth/authorization.js');
    expect(effectiveRole({ email: ADMIN_EMAIL, emailVerified: true })).toBe('ADMIN');
    expect(effectiveRole({ email: SUPPORT_EMAIL, emailVerified: true })).toBe('ADMIN');
    expect(effectiveRole({ email: ADMIN_EMAIL, emailVerified: false })).toBe('CUSTOMER');
    expect(effectiveRole({ email: SUPPORT_EMAIL, emailVerified: false })).toBe('CUSTOMER');
    expect(effectiveRole({ email: 'shopper@example.com', emailVerified: true })).toBe('CUSTOMER');
  });

  it('ignores a forged Firebase admin claim on a non-authorized email', async () => {
    const { isFirebaseAuthorizedAdmin } = await import('../src/modules/auth/authorization.js');
    expect(isFirebaseAuthorizedAdmin({ email: 'shopper@example.com', admin: true })).toBe(false);
    expect(isFirebaseAuthorizedAdmin({ email: undefined, admin: true })).toBe(false);
    // The claim alone (without the authorized email) is never sufficient.
    expect(isFirebaseAuthorizedAdmin({ email: ADMIN_EMAIL, admin: false })).toBe(false);
    expect(isFirebaseAuthorizedAdmin({ email: ADMIN_EMAIL, admin: true })).toBe(true);
    expect(isFirebaseAuthorizedAdmin({ email: SUPPORT_EMAIL, admin: true })).toBe(true);
  });
});

describe('server-enforced admin access over HTTP (legacy session path)', () => {
  let app: Express;

  beforeAll(async () => {
    const mod = await import('../src/app.js');
    app = mod.createApp();
  });

  async function registerCustomer(): Promise<AgentWithCsrf & { email: string; userId: string }> {
    const { agent, csrfToken } = await createAgent(app);
    const email = uniqueEmail('plain-customer');
    const res = await agent
      .post('/api/v1/auth/register')
      .set('X-CSRF-Token', csrfToken)
      .send({ name: 'Plain Customer', email, password: 'plainpassword1' });
    expect(res.status).toBe(201);
    return { agent, csrfToken, email, userId: res.body.data.user.id as string };
  }

  it('allows BOTH official accounts to reach every admin area independently', async () => {
    const primary = await getAdminAgent(app);
    const support = await getSupportAdminAgent(app);

    const adminGetRoutes = [
      '/api/v1/admin/orders',
      '/api/v1/admin/returns',
      '/api/v1/admin/inquiries/contact',
      '/api/v1/admin/inquiries/product',
      '/api/v1/admin/inquiries/support',
      '/api/v1/admin/payments/summary',
      '/api/v1/admin/payment-exceptions',
      '/api/v1/admin/refunds',
    ];

    for (const route of adminGetRoutes) {
      expect((await primary.agent.get(route)).status, `primary ${route}`).toBe(200);
      // The support account never impersonates the primary account: it uses its
      // own separate session and is authorized on its own.
      expect((await support.agent.get(route)).status, `support ${route}`).toBe(200);
    }
  });

  it('reports the ADMIN role for both accounts on /auth/me', async () => {
    const primary = await getAdminAgent(app);
    const support = await getSupportAdminAgent(app);
    expect((await primary.agent.get('/api/v1/auth/me')).body.data.user.role).toBe('ADMIN');
    expect((await support.agent.get('/api/v1/auth/me')).body.data.user.role).toBe('ADMIN');
  });

  it('403s an ordinary customer on admin routes and keeps them a customer', async () => {
    const customer = await registerCustomer();
    expect((await customer.agent.get('/api/v1/admin/orders')).status).toBe(403);
    expect((await customer.agent.get('/api/v1/admin/inquiries/contact')).status).toBe(403);
    const me = await customer.agent.get('/api/v1/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.data.user.role).toBe('CUSTOMER');
  });

  it('401s a guest (no session) on every admin route', async () => {
    const { agent } = await createAgent(app);
    expect((await agent.get('/api/v1/admin/orders')).status).toBe(401);
  });

  it('denies a customer whose raw DB role was forged to ADMIN', async () => {
    const { prisma } = await import('../src/lib/prisma.js');
    const customer = await registerCustomer();
    await prisma.user.update({ where: { id: customer.userId }, data: { role: 'ADMIN' } });

    expect((await customer.agent.get('/api/v1/admin/orders')).status).toBe(403);
    const me = await customer.agent.get('/api/v1/auth/me');
    expect(me.body.data.user.role).toBe('CUSTOMER');
  });

  it('denies an authorized email while its email is unverified (legacy path)', async () => {
    const { prisma } = await import('../src/lib/prisma.js');
    await ensureAdminUser(SUPPORT_EMAIL, undefined, SUPPORT_ADMIN_PASSWORD);
    await prisma.user.update({ where: { email: SUPPORT_EMAIL }, data: { emailVerified: false } });
    try {
      const support = await loginAgent(app, SUPPORT_EMAIL, SUPPORT_ADMIN_PASSWORD);
      expect((await support.agent.get('/api/v1/auth/me')).body.data.user.role).toBe('CUSTOMER');
      expect((await support.agent.get('/api/v1/admin/orders')).status).toBe(403);
    } finally {
      await prisma.user.update({ where: { email: SUPPORT_EMAIL }, data: { emailVerified: true } });
    }
  });
});
