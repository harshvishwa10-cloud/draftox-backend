// Restricted customer-support role. Verifies, over HTTP and server-side, that
// the support account (SUPPORT_EMAILS) can reach ONLY the public-request inbox
// while every financial / order / shipment / refund / payment / returns route
// stays behind the full-admin gate — and that the primary admin keeps full
// access. Also proves an unverified support email, an unrelated verified user,
// and CSRF/guest rules behave correctly.
import { beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { createAgent, uniqueEmail } from './helpers/agent.js';
import {
  ADMIN_EMAIL,
  SUPPORT_EMAIL,
  SUPPORT_NAME,
  SUPPORT_PASSWORD,
  ensureAdminUser,
  getAdminAgent,
  getSupportAgent,
  loginAgent,
} from './helpers/admin.js';

let app: Express;

beforeAll(async () => {
  const mod = await import('../src/app.js');
  app = mod.createApp();
});

// Routes the restricted support role MUST be able to reach (inbox only).
const SUPPORT_ALLOWED_GET = [
  '/api/v1/admin/inquiries/contact',
  '/api/v1/admin/inquiries/product',
  '/api/v1/admin/inquiries/support',
];

// Routes the restricted support role MUST be denied (full-admin only).
const SUPPORT_DENIED_GET = [
  '/api/v1/admin/orders',
  '/api/v1/admin/orders/some-order-id',
  '/api/v1/admin/returns',
  '/api/v1/admin/returns/some-return-id',
  '/api/v1/admin/payments/summary',
  '/api/v1/admin/payment-exceptions',
  '/api/v1/admin/refunds',
];

describe('restricted support role over HTTP (legacy session path)', () => {
  it('allows support to read the public-request inbox', async () => {
    const support = await getSupportAgent(app);
    for (const route of SUPPORT_ALLOWED_GET) {
      expect((await support.agent.get(route)).status, route).toBe(200);
    }
  });

  it('allows support to PATCH an inquiry status (guard passes; unknown id → 404)', async () => {
    const support = await getSupportAgent(app);
    for (const base of ['contact', 'product', 'support']) {
      const res = await support.agent
        .patch(`/api/v1/admin/inquiries/${base}/does-not-exist`)
        .set('X-CSRF-Token', support.csrfToken)
        .send({ status: 'RESOLVED' });
      // 404 (not 403) proves the support authorization guard let the request in.
      expect(res.status, base).toBe(404);
    }
  });

  it('allows support to hit the owner-notification retry route (guard passes; unknown id → 404)', async () => {
    const support = await getSupportAgent(app);
    const res = await support.agent
      .post('/api/v1/admin/inquiry-notifications/does-not-exist/retry')
      .set('X-CSRF-Token', support.csrfToken)
      .send({});
    expect(res.status).toBe(404);
  });

  it('denies support every full-admin route (orders, returns, payments, refunds)', async () => {
    const support = await getSupportAgent(app);
    for (const route of SUPPORT_DENIED_GET) {
      expect((await support.agent.get(route)).status, route).toBe(403);
    }
  });

  it('denies support the state-changing admin routes', async () => {
    const support = await getSupportAgent(app);
    const attempts: Array<[string, string, () => Promise<{ status: number }>]> = [
      [
        'PATCH',
        '/api/v1/admin/orders/some-id/fulfillment',
        () => support.agent.patch('/api/v1/admin/orders/some-id/fulfillment').set('X-CSRF-Token', support.csrfToken).send({ status: 'FULFILLED' }),
      ],
      [
        'PATCH',
        '/api/v1/admin/orders/some-id/shipment',
        () => support.agent.patch('/api/v1/admin/orders/some-id/shipment').set('X-CSRF-Token', support.csrfToken).send({}),
      ],
      [
        'POST',
        '/api/v1/admin/orders/some-id/reconcile-payment',
        () => support.agent.post('/api/v1/admin/orders/some-id/reconcile-payment').set('X-CSRF-Token', support.csrfToken).send({}),
      ],
      [
        'POST',
        '/api/v1/admin/refunds/some-id/retry',
        () => support.agent.post('/api/v1/admin/refunds/some-id/retry').set('X-CSRF-Token', support.csrfToken).send({}),
      ],
      [
        'PATCH',
        '/api/v1/admin/returns/some-id',
        () => support.agent.patch('/api/v1/admin/returns/some-id').set('X-CSRF-Token', support.csrfToken).send({ decision: 'APPROVED' }),
      ],
    ];
    for (const [method, route, run] of attempts) {
      const res = await run();
      expect(res.status, `${method} ${route}`).toBe(403);
    }
  });

  it('reports the CUSTOMER role for the support account on /auth/me', async () => {
    const support = await getSupportAgent(app);
    const me = await support.agent.get('/api/v1/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.data.user.role).toBe('CUSTOMER');
  });

  it('requires CSRF on the support state-changing route', async () => {
    const support = await getSupportAgent(app);
    const res = await support.agent
      .post('/api/v1/admin/inquiry-notifications/does-not-exist/retry')
      .send({}); // no X-CSRF-Token header
    expect(res.status).toBe(403);
  });

  it('still grants the primary admin full access to both inbox and admin routes', async () => {
    const admin = await getAdminAgent(app);
    expect((await admin.agent.get('/api/v1/admin/inquiries/contact')).status).toBe(200);
    expect((await admin.agent.get('/api/v1/admin/orders')).status).toBe(200);
    expect((await admin.agent.get('/api/v1/admin/payments/summary')).status).toBe(200);
  });
});

describe('support role negative cases', () => {
  it('denies an unrelated verified customer the inbox and the admin routes', async () => {
    const { agent, csrfToken } = await createAgent(app);
    const email = uniqueEmail('plain-support-negative');
    const reg = await agent
      .post('/api/v1/auth/register')
      .set('X-CSRF-Token', csrfToken)
      .send({ name: 'Plain Customer', email, password: 'plainpassword1' });
    expect(reg.status).toBe(201);

    expect((await agent.get('/api/v1/admin/inquiries/contact')).status).toBe(403);
    expect((await agent.get('/api/v1/admin/orders')).status).toBe(403);
  });

  it('denies an UNVERIFIED support email the inbox (and admin) routes', async () => {
    const { prisma } = await import('../src/lib/prisma.js');
    await ensureAdminUser(SUPPORT_EMAIL, SUPPORT_NAME, SUPPORT_PASSWORD);
    await prisma.user.update({ where: { email: SUPPORT_EMAIL }, data: { emailVerified: false } });
    try {
      const support = await loginAgent(app, SUPPORT_EMAIL, SUPPORT_PASSWORD);
      for (const route of SUPPORT_ALLOWED_GET) {
        expect((await support.agent.get(route)).status, route).toBe(403);
      }
      expect((await support.agent.get('/api/v1/admin/orders')).status).toBe(403);
      expect((await support.agent.get('/api/v1/auth/me')).body.data.user.role).toBe('CUSTOMER');
    } finally {
      await prisma.user.update({ where: { email: SUPPORT_EMAIL }, data: { emailVerified: true } });
    }
  });

  it('blocks password registration of the privileged support email', async () => {
    const { agent, csrfToken } = await createAgent(app);
    const res = await agent
      .post('/api/v1/auth/register')
      .set('X-CSRF-Token', csrfToken)
      .send({ name: 'Impostor', email: SUPPORT_EMAIL, password: 'impostorpassword1' });
    expect(res.status).toBe(409);
  });

  it('does not grant admin to the support email via a forged role/claim (config view)', async () => {
    const { isAuthorizedAdmin, isAuthorizedSupport, effectiveRole } = await import(
      '../src/modules/auth/authorization.js'
    );
    expect(isAuthorizedAdmin({ email: SUPPORT_EMAIL, emailVerified: true })).toBe(false);
    expect(effectiveRole({ email: SUPPORT_EMAIL, emailVerified: true })).not.toBe('ADMIN');
    // Sanity: the primary admin address is unaffected.
    expect(isAuthorizedAdmin({ email: ADMIN_EMAIL, emailVerified: true })).toBe(true);
    expect(isAuthorizedSupport({ email: SUPPORT_EMAIL, emailVerified: true })).toBe(true);
  });
});
