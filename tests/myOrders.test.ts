// Enables Razorpay (via the helper) BEFORE src/config/env.ts is first evaluated,
// so the verified-payment case below can run. Must stay the first import.
import './helpers/razorpay-env.js';
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Express } from 'express';
import { createAgent, uniqueEmail, type AgentWithCsrf } from './helpers/agent.js';

const KEY_SECRET = 'dummy_key_secret_for_tests';
const KEY_ID = 'rzp_test_dummykey0001';
const SEED_PRICE = 7999;
// Single-unit 16-channel order total: catalog price + flat delivery fee.
const SEED_TOTAL = SEED_PRICE + 110;

let app: Express;
let fetchMock: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  const mod = await import('../src/app.js');
  app = mod.createApp();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

beforeEach(() => {
  fetchMock.mockReset();
});

afterAll(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(payload: unknown, ok = true) {
  return Promise.resolve({ ok, status: ok ? 200 : 400, json: async () => payload });
}

let idCounter = 0;
function uniqueId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}${idCounter}${Math.random().toString(36).slice(2, 7)}`;
}

async function registerAgent(): Promise<AgentWithCsrf & { email: string }> {
  const { agent, csrfToken } = await createAgent(app);
  const email = uniqueEmail('orders');
  const res = await agent
    .post('/api/v1/auth/register')
    .set('X-CSRF-Token', csrfToken)
    .send({ name: 'Orders Person', email, password: 'testpassword1' });
  expect(res.status).toBe(201);
  return { agent, csrfToken, email };
}

async function seed16Id(): Promise<string> {
  const { prisma } = await import('../src/lib/prisma.js');
  const row = await prisma.product.findUnique({
    where: { slug: 'draftox-16-channel' },
    select: { id: true },
  });
  if (!row) throw new Error('seeded 16-channel product missing from test DB');
  return row.id;
}

interface OrderLike {
  id: string;
  orderNumber: string | null;
  status: string;
  amount: number | string;
  items: Array<{ name: string; unitPrice: number }>;
  paymentMethod?: string | null;
}

async function fileOrder(
  auth: AgentWithCsrf & { email: string },
  qty = 1,
): Promise<OrderLike> {
  const res = await auth.agent
    .post('/api/v1/orders')
    .set('X-CSRF-Token', auth.csrfToken)
    .send({
      items: [{ productId: await seed16Id(), qty }],
      name: 'Orders Person',
      email: auth.email,
      phone: '+91 98765 43210',
      address: { line: '1 Main Street', city: 'Mumbai', state: 'Maharashtra', pincode: '400001' },
    });
  expect(res.status).toBe(201);
  return res.body.data.order as OrderLike;
}

/* ------------------------------------------------------------------ */
/* 5-digit order numbers                                              */
/* ------------------------------------------------------------------ */

describe('customer-facing order numbers', () => {
  it('assigns a unique, well-formed 5-digit number to every order', async () => {
    const auth = await registerAgent();
    const numbers: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const order = await fileOrder(auth, 1);
      expect(order.orderNumber).toMatch(/^\d{5}$/);
      expect(Number(order.orderNumber)).toBeGreaterThanOrEqual(10000);
      expect(Number(order.orderNumber)).toBeLessThanOrEqual(99999);
      numbers.push(order.orderNumber as string);
    }
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it('never hands the same number to concurrent orders', async () => {
    const auth = await registerAgent();
    const productId = await seed16Id();
    const payload = {
      items: [{ productId, qty: 1 }],
      name: 'Orders Person',
      email: auth.email,
      address: { line: '1 Main Street', city: 'Mumbai', state: 'Maharashtra', pincode: '400001' },
    };

    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        auth.agent.post('/api/v1/orders').set('X-CSRF-Token', auth.csrfToken).send(payload),
      ),
    );
    for (const res of responses) expect(res.status).toBe(201);
    const numbers = responses.map((r) => r.body.data.order.orderNumber as string);
    expect(numbers.every((n) => /^\d{5}$/.test(n))).toBe(true);
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it('fails loudly instead of duplicating once the number space is exhausted', async () => {
    const { prisma } = await import('../src/lib/prisma.js');
    const auth = await registerAgent();
    const previous = await prisma.orderCounter.findUnique({ where: { key: 'order_number' } });

    await prisma.orderCounter.update({ where: { key: 'order_number' }, data: { value: 99999 } });
    try {
      const productId = await seed16Id();
      const res = await auth.agent
        .post('/api/v1/orders')
        .set('X-CSRF-Token', auth.csrfToken)
        .send({
          items: [{ productId, qty: 1 }],
          name: 'Orders Person',
          email: auth.email,
          address: { line: '1 Main Street', city: 'Mumbai', state: 'Maharashtra', pincode: '400001' },
        });
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('ORDER_NUMBER_EXHAUSTED');

      // The failure must not have consumed or fabricated a number.
      const counter = await prisma.orderCounter.findUnique({ where: { key: 'order_number' } });
      expect(counter?.value).toBe(99999);
    } finally {
      if (previous) {
        await prisma.orderCounter.update({
          where: { key: 'order_number' },
          data: { value: previous.value },
        });
      }
    }
  });
});

/* ------------------------------------------------------------------ */
/* Access control                                                      */
/* ------------------------------------------------------------------ */

describe('My Orders access control', () => {
  it('lists the signed-in user’s orders newest-first and fetches one by number', async () => {
    const auth = await registerAgent();
    const first = await fileOrder(auth, 1);
    const second = await fileOrder(auth, 2);

    const list = await auth.agent.get('/api/v1/orders');
    expect(list.status).toBe(200);
    const ids = list.body.data.orders.map((o: OrderLike) => o.id);
    expect(ids).toContain(first.id);
    expect(ids).toContain(second.id);
    // Newest first.
    expect(ids.indexOf(second.id)).toBeLessThan(ids.indexOf(first.id));

    const byNumber = await auth.agent.get(`/api/v1/orders/by-number/${second.orderNumber}`);
    expect(byNumber.status).toBe(200);
    expect(byNumber.body.data.order.id).toBe(second.id);
  });

  it("never reveals another customer's order by guessing the number", async () => {
    const owner = await registerAgent();
    const order = await fileOrder(owner, 1);
    const other = await registerAgent();

    const res = await other.agent.get(`/api/v1/orders/by-number/${order.orderNumber}`);
    expect(res.status).toBe(404);
    expect(res.body.data).toBeUndefined();
  });

  it('404s for malformed or unknown order numbers', async () => {
    const auth = await registerAgent();
    for (const bad of ['1234', '123456', 'abcde', '00000']) {
      const res = await auth.agent.get(`/api/v1/orders/by-number/${bad}`);
      expect(res.status).toBe(404);
    }
    const unknown = await auth.agent.get('/api/v1/orders/by-number/99999');
    expect(unknown.status).toBe(404);
  });

  it('401s for guests', async () => {
    const { agent } = await createAgent(app);
    expect((await agent.get('/api/v1/orders')).status).toBe(401);
    expect((await agent.get('/api/v1/orders/by-number/12345')).status).toBe(401);
  });
});

/* ------------------------------------------------------------------ */
/* Immutable snapshot + catalog integrity                             */
/* ------------------------------------------------------------------ */

describe('immutable order snapshot', () => {
  it('keeps item name and unit price even after the catalog changes', async () => {
    const { prisma } = await import('../src/lib/prisma.js');
    const product = await prisma.product.findUnique({
      where: { slug: 'draftox-16-channel' },
      select: { id: true, name: true, price: true },
    });
    expect(product).not.toBeNull();

    const auth = await registerAgent();
    const order = await fileOrder(auth, 1);
    const frozenName = order.items[0].name;
    const frozenPrice = order.items[0].unitPrice;

    try {
      await prisma.product.update({
        where: { slug: 'draftox-16-channel' },
        data: { name: 'Renamed After Checkout', price: 12345 },
      });

      const res = await auth.agent.get(`/api/v1/orders/by-number/${order.orderNumber}`);
      expect(res.status).toBe(200);
      expect(res.body.data.order.items[0].name).toBe(frozenName);
      expect(res.body.data.order.items[0].unitPrice).toBe(frozenPrice);
    } finally {
      await prisma.product.update({
        where: { slug: 'draftox-16-channel' },
        data: { name: product!.name, price: product!.price },
      });
    }
  });

  it('keeps exactly the three relay systems with their configured prices', async () => {
    const { prisma } = await import('../src/lib/prisma.js');
    // The shared test DB accumulates throwaway products from other suites, so
    // assert on the three real catalog slugs rather than "only 3 rows exist".
    const products = await prisma.product.findMany({
      where: {
        slug: { in: ['draftox-16-channel', 'draftox-24-channel', 'draftox-40-channel'] },
      },
      select: { slug: true, price: true, status: true },
    });
    const bySlug = new Map(products.map((p) => [p.slug, p]));
    expect([...bySlug.keys()].sort()).toEqual([
      'draftox-16-channel',
      'draftox-24-channel',
      'draftox-40-channel',
    ]);
    expect(bySlug.get('draftox-16-channel')?.status).toBe('PUBLISHED');
    expect(Number(bySlug.get('draftox-16-channel')?.price)).toBe(SEED_PRICE);
    expect(Number(bySlug.get('draftox-24-channel')?.price)).toBe(11999);
    expect(Number(bySlug.get('draftox-40-channel')?.price)).toBe(19999);
  });
});

/* ------------------------------------------------------------------ */
/* Verified payment -> exactly one PAID order                          */
/* ------------------------------------------------------------------ */

describe('verified payment produces exactly one paid order', () => {
  it('marks one order PAID, records the method, and is idempotent', async () => {
    const { prisma } = await import('../src/lib/prisma.js');
    const auth = await registerAgent();
    const order = await fileOrder(auth, 1);
    const providerOrderId = uniqueId('order');
    const paymentId = uniqueId('pay');

    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith('/orders')) return jsonResponse({ id: providerOrderId });
      if (url.includes('/payments/')) {
        return jsonResponse({
          id: paymentId,
          order_id: providerOrderId,
          amount: SEED_TOTAL * 100,
          currency: 'INR',
          status: 'captured',
          method: 'upi',
        });
      }
      return jsonResponse({}, false);
    });

    const initiated = await auth.agent
      .post('/api/v1/payments/razorpay/order')
      .set('X-CSRF-Token', auth.csrfToken)
      .send({ orderId: order.id });
    expect(initiated.status).toBe(201);
    expect(initiated.body.data.keyId).toBe(KEY_ID);

    const { buildPaymentSignature } = await import('../src/modules/payments/razorpay.js');
    const payload = {
      orderId: order.id,
      razorpayOrderId: providerOrderId,
      razorpayPaymentId: paymentId,
      razorpaySignature: buildPaymentSignature(providerOrderId, paymentId, KEY_SECRET),
    };

    const first = await auth.agent
      .post('/api/v1/payments/razorpay/verify')
      .set('X-CSRF-Token', auth.csrfToken)
      .send(payload);
    expect(first.status).toBe(200);
    expect(first.body.data.status).toBe('PAID');
    expect(first.body.data.order.orderNumber).toBe(order.orderNumber);
    expect(first.body.data.order.paymentMethod).toBe('upi');

    // Repeat callback/webhook must not create a second paid order.
    const second = await auth.agent
      .post('/api/v1/payments/razorpay/verify')
      .set('X-CSRF-Token', auth.csrfToken)
      .send(payload);
    expect(second.status).toBe(200);
    expect(second.body.data.alreadyPaid).toBe(true);

    const paidCount = await prisma.order.count({ where: { id: order.id, status: 'PAID' } });
    expect(paidCount).toBe(1);
  });
});
