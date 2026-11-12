// Exercises the ACTIVE local test-price override end to end: the public
// catalogue API and real order creation both return ₹10 for the 16-channel
// system (10 + 110 delivery = 120) while the other two systems stay at their
// catalogue prices. setup-env.ts forces the flag off for every test file; here
// we turn it on for this file only (the app's dotenv does not override an
// already-defined value).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';
import { createAgent, uniqueEmail, type AgentWithCsrf } from './helpers/agent.js';

let app: Express;
const ordersToCleanup: string[] = [];
const ORIGINAL_FLAG = process.env.DEV_TEST_PRICE_ENABLED;

beforeAll(async () => {
  process.env.DEV_TEST_PRICE_ENABLED = 'true';
  const mod = await import('../src/app.js');
  app = mod.createApp();
});

afterAll(async () => {
  const { prisma } = await import('../src/lib/prisma.js');
  await Promise.all(
    ordersToCleanup.map((id) => prisma.order.delete({ where: { id } }).catch(() => undefined)),
  );
  if (ORIGINAL_FLAG === undefined) delete process.env.DEV_TEST_PRICE_ENABLED;
  else process.env.DEV_TEST_PRICE_ENABLED = ORIGINAL_FLAG;
});

interface Authed extends AgentWithCsrf {
  email: string;
}

async function registerAgent(prefix: string): Promise<Authed> {
  const { agent, csrfToken } = await createAgent(app);
  const email = uniqueEmail(prefix);
  const res = await agent
    .post('/api/v1/auth/register')
    .set('X-CSRF-Token', csrfToken)
    .send({ name: 'Price Person', email, password: 'testpassword1' });
  expect(res.status).toBe(201);
  return { agent, csrfToken, email };
}

async function productId(slug: string): Promise<string> {
  const { prisma } = await import('../src/lib/prisma.js');
  const row = await prisma.product.findUnique({ where: { slug }, select: { id: true } });
  if (!row) throw new Error(`seeded product ${slug} missing from test DB`);
  return row.id;
}

interface OrderLike {
  id: string;
  status: string;
  paymentMethod: string | null;
  subtotal: number | string;
  amount: number | string;
  items: Array<{ slug?: string; unitPrice: number | string }>;
}

async function createOrder(
  auth: Authed,
  slug: string,
  qty: number,
  paymentMethod?: 'cod',
): Promise<OrderLike> {
  const payload: Record<string, unknown> = {
    items: [{ productId: await productId(slug), qty }],
    name: 'Price Person',
    email: auth.email,
    phone: '+91 98765 43210',
    address: { line: '1 Main Street', city: 'Mumbai', state: 'Maharashtra', pincode: '400001' },
  };
  if (paymentMethod) payload.paymentMethod = paymentMethod;
  const res = await auth.agent
    .post('/api/v1/orders')
    .set('X-CSRF-Token', auth.csrfToken)
    .send(payload);
  expect(res.status).toBe(201);
  const order = res.body.data.order as OrderLike;
  ordersToCleanup.push(order.id);
  return order;
}

describe('catalogue API while the override is active', () => {
  it('serves ₹10 for the 16-channel system and catalogue prices for the others', async () => {
    // Search-scoped so the assertion is independent of other products that may
    // accumulate in the shared test database between files.
    const res = await request(app).get(
      `/api/v1/products?search=${encodeURIComponent('Relay System')}`,
    );
    expect(res.status).toBe(200);
    const bySlug = Object.fromEntries(
      (res.body.data.items as Array<{ slug: string; price: unknown }>).map((i) => [
        i.slug,
        Number(i.price),
      ]),
    );
    expect(bySlug['draftox-16-channel']).toBe(10);
    expect(bySlug['draftox-24-channel']).toBe(11999);
    expect(bySlug['draftox-40-channel']).toBe(19999);
  });

  it('serves ₹10 on the single-product endpoint too', async () => {
    const res = await request(app).get('/api/v1/products/draftox-16-channel');
    expect(res.status).toBe(200);
    expect(Number(res.body.data.product.price)).toBe(10);
  });
});

describe('order pricing while the override is active', () => {
  it('charges ₹10 + ₹110 = ₹120 on a 16-channel online order', async () => {
    const auth = await registerAgent('price-online');
    const order = await createOrder(auth, 'draftox-16-channel', 1);
    expect(Number(order.subtotal)).toBe(10);
    expect(Number(order.amount)).toBe(120);
    expect(order.status).toBe('REQUESTED');
  });

  it('charges ₹10 + ₹110 = ₹120 on a 16-channel COD order', async () => {
    const auth = await registerAgent('price-cod');
    const order = await createOrder(auth, 'draftox-16-channel', 1, 'cod');
    expect(Number(order.subtotal)).toBe(10);
    expect(Number(order.amount)).toBe(120);
    expect(order.status).toBe('CONFIRMED');
  });

  it('keeps the 24-channel and 40-channel systems at catalogue prices with free delivery', async () => {
    const auth = await registerAgent('price-other');
    const twentyFour = await createOrder(auth, 'draftox-24-channel', 1);
    expect(Number(twentyFour.subtotal)).toBe(11999);
    expect(Number(twentyFour.amount)).toBe(11999);

    const forty = await createOrder(auth, 'draftox-40-channel', 1);
    expect(Number(forty.subtotal)).toBe(19999);
    expect(Number(forty.amount)).toBe(19999);
  });
});
