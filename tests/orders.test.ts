import { beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { createAgent, uniqueEmail } from './helpers/agent.js';

let app: Express;

beforeAll(() => {
  app = createApp();
});

async function registerAgent() {
  const { agent, csrfToken } = await createAgent(app);
  const email = uniqueEmail('buyer');
  const res = await agent
    .post('/api/v1/auth/register')
    .set('X-CSRF-Token', csrfToken)
    .send({ name: 'Buyer Person', email, password: 'testpassword1' });
  expect(res.status).toBe(201);
  return { agent, csrfToken, email };
}

const orderPayload = {
  items: [{ productId: 'SEED-16', qty: 2 }],
  name: 'Buyer Person',
  email: 'buyer@example.com',
  phone: '+91 98765 43210',
  address: { line: '1 Main Street', city: 'Mumbai', state: 'Maharashtra', pincode: '400001' },
};

async function seed16Id(): Promise<string> {
  const { prisma } = await import('../src/lib/prisma.js');
  const row = await prisma.product.findUnique({
    where: { slug: 'draftox-16-channel' },
    select: { id: true },
  });
  if (!row) throw new Error('seeded 16-channel product missing from test DB');
  return row.id;
}

describe('POST /api/v1/orders', () => {
  it('computes totals server-side from DB prices (ignores client math)', async () => {
    const { agent, csrfToken } = await createAgent(app);
    const res = await agent
      .post('/api/v1/orders')
      .set('X-CSRF-Token', csrfToken)
      .send({ ...orderPayload, items: [{ productId: await seed16Id(), qty: 2 }] });

    expect(res.status).toBe(201);
    expect(res.body.data.order.status).toBe('REQUESTED');
    // Seeded 16-channel price is 7999 → 2 units = 15998, computed by the server.
    expect(Number(res.body.data.order.amount)).toBe(15998);
    expect(Number(res.body.data.order.subtotal)).toBe(15998);
    expect(res.body.data.order.items[0].unitPrice).toBe(7999);
    expect(res.body.data.order.id).toBeTruthy();
  });

  it('404s for unknown or unpublished products', async () => {
    const { agent, csrfToken } = await createAgent(app);
    const res = await agent
      .post('/api/v1/orders')
      .set('X-CSRF-Token', csrfToken)
      .send({ ...orderPayload, items: [{ productId: 'does-not-exist', qty: 1 }] });
    expect(res.status).toBe(404);
  });

  it('422s for empty carts', async () => {
    const { agent, csrfToken } = await createAgent(app);
    const res = await agent
      .post('/api/v1/orders')
      .set('X-CSRF-Token', csrfToken)
      .send({ ...orderPayload, items: [] });
    expect(res.status).toBe(422);
  });
});

describe('GET /api/v1/orders (auth)', () => {
  it('401s for guests', async () => {
    const { agent } = await createAgent(app);
    const res = await agent.get('/api/v1/orders');
    expect(res.status).toBe(401);
  });

  it("lists only the signed-in user's orders, with detail access", async () => {
    const { agent, csrfToken } = await registerAgent();
    const created = await agent
      .post('/api/v1/orders')
      .set('X-CSRF-Token', csrfToken)
      .send({ ...orderPayload, items: [{ productId: await seed16Id(), qty: 1 }] });
    expect(created.status).toBe(201);
    const id = created.body.data.order.id as string;

    const list = await agent.get('/api/v1/orders');
    expect(list.status).toBe(200);
    expect(list.body.data.orders.map((o: { id: string }) => o.id)).toContain(id);

    const one = await agent.get(`/api/v1/orders/${id}`);
    expect(one.status).toBe(200);
    expect(one.body.data.order.id).toBe(id);

    // Another user cannot see it.
    const other = await registerAgent();
    const denied = await other.agent.get(`/api/v1/orders/${id}`);
    expect(denied.status).toBe(404);
  });
});

describe('payments (unconfigured provider)', () => {
  it('reports razorpay as not configured', async () => {
    const { agent } = await createAgent(app);
    const res = await agent.get('/api/v1/payments/status');
    expect(res.status).toBe(200);
    expect(res.body.data.razorpay).toBe(false);
  });

  it('503s payment initiation without credentials (never fakes an order)', async () => {
    const { agent, csrfToken } = await registerAgent();
    const created = await agent
      .post('/api/v1/orders')
      .set('X-CSRF-Token', csrfToken)
      .send({ ...orderPayload, items: [{ productId: await seed16Id(), qty: 1 }] });
    const res = await agent
      .post('/api/v1/payments/razorpay/order')
      .set('X-CSRF-Token', csrfToken)
      .send({ orderId: created.body.data.order.id });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
  });
});

describe('GET /api/v1/auth/providers', () => {
  it('reports google as not configured without credentials', async () => {
    const { agent } = await createAgent(app);
    const res = await agent.get('/api/v1/auth/providers');
    expect(res.status).toBe(200);
    expect(res.body.data.google).toBe(false);
  });
});
