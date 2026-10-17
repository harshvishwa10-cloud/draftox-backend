// NOTE: './helpers/orders-disabled-env.js' MUST stay the first import — it
// flips STORE_ORDERS_ENABLED=false BEFORE src/config/env.ts is first evaluated
// for this test file.
import './helpers/orders-disabled-env.js';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { createAgent, uniqueEmail } from './helpers/agent.js';

let app: Express;

beforeAll(() => {
  app = createApp();
});

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

async function registerAgent() {
  const { agent, csrfToken } = await createAgent(app);
  const email = uniqueEmail('pausedbuyer');
  const res = await agent
    .post('/api/v1/auth/register')
    .set('X-CSRF-Token', csrfToken)
    .send({ name: 'Paused Buyer', email, password: 'testpassword1' });
  expect(res.status).toBe(201);
  return { agent, csrfToken };
}

describe('ordering disabled (STORE_ORDERS_ENABLED=false)', () => {
  it('rejects new order creation with 503 ORDERS_DISABLED — the gate is server-side', async () => {
    const { agent, csrfToken } = await createAgent(app);
    const res = await agent
      .post('/api/v1/orders')
      .set('X-CSRF-Token', csrfToken)
      .send({ ...orderPayload, items: [{ productId: await seed16Id(), qty: 2 }] });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('ORDERS_DISABLED');
  });

  it('rejects Razorpay order initiation with 503 ORDERS_DISABLED (no new money)', async () => {
    const { agent, csrfToken } = await registerAgent();
    const res = await agent
      .post('/api/v1/payments/razorpay/order')
      .set('X-CSRF-Token', csrfToken)
      .send({ orderId: 'does-not-matter' });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('ORDERS_DISABLED');
  });

  it('keeps read paths live: catalog, order history and payment status', async () => {
    const { agent } = await createAgent(app);

    const catalog = await agent.get('/api/v1/products?limit=50');
    expect(catalog.status).toBe(200);

    const status = await agent.get('/api/v1/payments/status');
    expect(status.status).toBe(200);

    // A freshly registered user can still list their (empty) order history.
    const { agent: buyer } = await registerAgent();
    const list = await buyer.get('/api/v1/orders');
    expect(list.status).toBe(200);
    expect(list.body.data.orders).toEqual([]);
  });
});