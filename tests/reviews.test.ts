import { beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { prisma } from '../src/lib/prisma.js';
import { createApp } from '../src/app.js';
import { createAgent, uniqueEmail, type AgentWithCsrf } from './helpers/agent.js';

let app: Express;

beforeAll(() => {
  app = createApp();
});

interface Auth extends AgentWithCsrf {
  email: string;
}

async function registerAgent(): Promise<Auth> {
  const { agent, csrfToken } = await createAgent(app);
  const email = uniqueEmail('reviewer');
  const res = await agent
    .post('/api/v1/auth/register')
    .set('X-CSRF-Token', csrfToken)
    .send({ name: 'Review Person', email, password: 'testpassword1' });
  expect(res.status).toBe(201);
  return { agent, csrfToken, email };
}

async function seed16Id(): Promise<string> {
  const row = await prisma.product.findUnique({
    where: { slug: 'draftox-16-channel' },
    select: { id: true },
  });
  if (!row) throw new Error('seeded 16-channel product missing from test DB');
  return row.id;
}

async function fileOrder(auth: Auth): Promise<{ id: string; orderNumber: string }> {
  const res = await auth.agent
    .post('/api/v1/orders')
    .set('X-CSRF-Token', auth.csrfToken)
    .send({
      items: [{ productId: await seed16Id(), qty: 1 }],
      name: 'Review Person',
      email: auth.email,
      phone: '+91 98765 43210',
      address: { line: '1 Main Street', city: 'Mumbai', state: 'Maharashtra', pincode: '400001' },
    });
  expect(res.status).toBe(201);
  return { id: res.body.data.order.id as string, orderNumber: res.body.data.order.orderNumber as string };
}

describe('POST /api/v1/reviews', () => {
  it('requires sign-in', async () => {
    const { agent, csrfToken } = await createAgent(app);
    const res = await agent
      .post('/api/v1/reviews')
      .set('X-CSRF-Token', csrfToken)
      .send({ orderId: 'anything', rating: 5 });
    expect(res.status).toBe(401);
  });

  it('creates one review for the owner and returns it in the order detail', async () => {
    const auth = await registerAgent();
    const order = await fileOrder(auth);

    const created = await auth.agent
      .post('/api/v1/reviews')
      .set('X-CSRF-Token', auth.csrfToken)
      .send({ orderId: order.id, rating: 5, title: 'Great service', body: 'Fast and clear.' });
    expect(created.status).toBe(201);
    expect(created.body.data.review.rating).toBe(5);

    const saved = await prisma.review.findUnique({ where: { orderId: order.id } });
    expect(saved).not.toBeNull();
    expect(saved!.rating).toBe(5);

    const detail = await auth.agent
      .get(`/api/v1/orders/by-number/${order.orderNumber}`)
      .set('X-CSRF-Token', auth.csrfToken);
    expect(detail.status).toBe(200);
    expect(detail.body.data.order.review.rating).toBe(5);
  });

  it('rejects a second review for the same order (409)', async () => {
    const auth = await registerAgent();
    const order = await fileOrder(auth);
    const first = await auth.agent
      .post('/api/v1/reviews')
      .set('X-CSRF-Token', auth.csrfToken)
      .send({ orderId: order.id, rating: 4 });
    expect(first.status).toBe(201);

    const second = await auth.agent
      .post('/api/v1/reviews')
      .set('X-CSRF-Token', auth.csrfToken)
      .send({ orderId: order.id, rating: 2 });
    expect(second.status).toBe(409);
  });

  it("never reveals another customer's order (404)", async () => {
    const owner = await registerAgent();
    const order = await fileOrder(owner);
    const other = await registerAgent();
    const res = await other.agent
      .post('/api/v1/reviews')
      .set('X-CSRF-Token', other.csrfToken)
      .send({ orderId: order.id, rating: 5 });
    expect(res.status).toBe(404);
  });

  it('validates the rating range (422)', async () => {
    const auth = await registerAgent();
    const order = await fileOrder(auth);
    for (const rating of [0, 6, 3.5]) {
      const res = await auth.agent
        .post('/api/v1/reviews')
        .set('X-CSRF-Token', auth.csrfToken)
        .send({ orderId: order.id, rating });
      expect(res.status).toBe(422);
    }
  });

  it('lists only the signed-in user reviews', async () => {
    const auth = await registerAgent();
    const order = await fileOrder(auth);
    await auth.agent
      .post('/api/v1/reviews')
      .set('X-CSRF-Token', auth.csrfToken)
      .send({ orderId: order.id, rating: 3 });

    const mine = await auth.agent.get('/api/v1/reviews').set('X-CSRF-Token', auth.csrfToken);
    expect(mine.status).toBe(200);
    expect(mine.body.data.reviews).toHaveLength(1);
    expect(mine.body.data.reviews[0].order.orderNumber).toBe(order.orderNumber);

    const other = await registerAgent();
    const theirList = await other.agent.get('/api/v1/reviews').set('X-CSRF-Token', other.csrfToken);
    expect(theirList.body.data.reviews).toEqual([]);
  });
});
