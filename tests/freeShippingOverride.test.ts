// NOTE: './helpers/razorpay-env.js' MUST stay the first import — it enables the
// Razorpay env BEFORE src/config/env.ts is first evaluated for this test file.
import './helpers/razorpay-env.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Express } from 'express';
import { createAgent, uniqueEmail, type AgentWithCsrf } from './helpers/agent.js';

// Proves the ACTIVE local free-shipping override end to end: with BOTH the token
// price and free-shipping flags on, the 16-channel system costs exactly ₹10
// (₹10 + ₹0 delivery), COD confirms at ₹10, and Razorpay is asked for exactly
// 1,000 paise. setup-env.ts forces both flags off for every test file; here we
// turn them on for this file only.
let app: Express;
let fetchMock: ReturnType<typeof vi.fn>;

const ordersToCleanup: string[] = [];
const ORIGINAL_PRICE_FLAG = process.env.DEV_TEST_PRICE_ENABLED;
const ORIGINAL_SHIPPING_FLAG = process.env.DEV_FREE_SHIPPING_ENABLED;

let idCounter = 0;
function uniqueId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}${idCounter}${Math.random().toString(36).slice(2, 7)}`;
}

beforeAll(async () => {
  process.env.DEV_TEST_PRICE_ENABLED = 'true';
  process.env.DEV_FREE_SHIPPING_ENABLED = 'true';
  const mod = await import('../src/app.js');
  app = mod.createApp();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

beforeEach(() => {
  fetchMock.mockReset();
});

afterAll(async () => {
  vi.unstubAllGlobals();
  const { prisma } = await import('../src/lib/prisma.js');
  await Promise.all(
    ordersToCleanup.map((id) => prisma.order.delete({ where: { id } }).catch(() => undefined)),
  );
  if (ORIGINAL_PRICE_FLAG === undefined) delete process.env.DEV_TEST_PRICE_ENABLED;
  else process.env.DEV_TEST_PRICE_ENABLED = ORIGINAL_PRICE_FLAG;
  if (ORIGINAL_SHIPPING_FLAG === undefined) delete process.env.DEV_FREE_SHIPPING_ENABLED;
  else process.env.DEV_FREE_SHIPPING_ENABLED = ORIGINAL_SHIPPING_FLAG;
});

function jsonResponse(payload: unknown, ok = true) {
  return Promise.resolve({ ok, status: ok ? 200 : 400, json: async () => payload });
}

interface Authed extends AgentWithCsrf {
  email: string;
}

async function registerAgent(prefix: string): Promise<Authed> {
  const { agent, csrfToken } = await createAgent(app);
  const email = uniqueEmail(prefix);
  const res = await agent
    .post('/api/v1/auth/register')
    .set('X-CSRF-Token', csrfToken)
    .send({ name: 'Ship Person', email, password: 'testpassword1' });
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
  subtotal: number | string;
  amount: number | string;
}

async function createOrder(
  auth: Authed,
  slug: string,
  qty: number,
  paymentMethod?: 'cod',
): Promise<OrderLike> {
  const payload: Record<string, unknown> = {
    items: [{ productId: await productId(slug), qty }],
    name: 'Ship Person',
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

describe('order pricing with the free-shipping override active', () => {
  it('charges exactly ₹10 (₹10 + ₹0) on a 16-channel online order', async () => {
    const auth = await registerAgent('ship-online');
    const order = await createOrder(auth, 'draftox-16-channel', 1);
    expect(Number(order.subtotal)).toBe(10);
    expect(Number(order.amount)).toBe(10);
    expect(order.status).toBe('REQUESTED');
  });

  it('confirms a 16-channel COD order at exactly ₹10', async () => {
    const auth = await registerAgent('ship-cod');
    const order = await createOrder(auth, 'draftox-16-channel', 1, 'cod');
    expect(Number(order.subtotal)).toBe(10);
    expect(Number(order.amount)).toBe(10);
    expect(order.status).toBe('CONFIRMED');
  });

  it('leaves the 24- and 40-channel systems unchanged', async () => {
    const auth = await registerAgent('ship-other');
    const twentyFour = await createOrder(auth, 'draftox-24-channel', 1);
    expect(Number(twentyFour.subtotal)).toBe(11999);
    expect(Number(twentyFour.amount)).toBe(11999);

    const forty = await createOrder(auth, 'draftox-40-channel', 1);
    expect(Number(forty.subtotal)).toBe(19999);
    expect(Number(forty.amount)).toBe(19999);
  });
});

describe('Razorpay initiation with the free-shipping override active', () => {
  it('asks the provider for exactly 1,000 paise on the ₹10 order', async () => {
    const auth = await registerAgent('ship-razorpay');
    const order = await createOrder(auth, 'draftox-16-channel', 1);
    expect(Number(order.amount)).toBe(10);

    const providerId = uniqueId('order');
    let sentBody: { amount?: number; currency?: string; receipt?: string } = {};
    fetchMock.mockImplementation((url: string, init?: { body?: string }) => {
      if (url.endsWith('/orders')) {
        sentBody = JSON.parse(init?.body ?? '{}');
        return jsonResponse({ id: providerId });
      }
      return jsonResponse({}, false);
    });

    const res = await auth.agent
      .post('/api/v1/payments/razorpay/order')
      .set('X-CSRF-Token', auth.csrfToken)
      .send({ orderId: order.id });

    expect(res.status).toBe(201);
    expect(res.body.data.razorpayOrderId).toBe(providerId);
    expect(res.body.data.amount).toBe(1000);
    expect(res.body.data.currency).toBe('INR');
    expect(sentBody.amount).toBe(1000);
    expect(sentBody.currency).toBe('INR');
  });
});
