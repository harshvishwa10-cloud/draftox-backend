// No Razorpay env needed: COD never touches the provider. Keep Razorpay disabled
// (the default test env) so any accidental provider call fails loudly.
import './helpers/razorpay-env.js';
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Express } from 'express';
import { createAgent, uniqueEmail, type AgentWithCsrf } from './helpers/agent.js';
import { getAdminAgent } from './helpers/admin.js';

let app: Express;
let fetchMock: ReturnType<typeof vi.fn>;
const ordersToCleanup: string[] = [];

beforeAll(async () => {
  const mod = await import('../src/app.js');
  app = mod.createApp();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

beforeEach(() => {
  fetchMock.mockReset();
  // Any network call to Razorpay should fail the test — COD must never call it.
  fetchMock.mockImplementation(() => Promise.reject(new Error('Unexpected network call — COD must not contact Razorpay')));
});

afterAll(async () => {
  vi.unstubAllGlobals();
  const { prisma } = await import('../src/lib/prisma.js');
  await Promise.all(
    ordersToCleanup.map((id) => prisma.order.delete({ where: { id } }).catch(() => undefined)),
  );
});

interface Authed extends AgentWithCsrf {
  email: string;
  userId: string;
}

async function registerAgent(prefix = 'cod'): Promise<Authed> {
  const { agent, csrfToken } = await createAgent(app);
  const email = uniqueEmail(prefix);
  const res = await agent
    .post('/api/v1/auth/register')
    .set('X-CSRF-Token', csrfToken)
    .send({ name: 'COD Person', email, password: 'testpassword1' });
  expect(res.status).toBe(201);
  return { agent, csrfToken, email, userId: res.body.data.user.id as string };
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

const SEED_PRICE = 7999;

interface OrderLike {
  id: string;
  orderNumber: string | null;
  status: string;
  fulfillmentStatus: string;
  paymentMethod: string | null;
  subtotal: number | string;
  amount: number | string;
  items: Array<{ name: string; unitPrice: number }>;
  razorpayOrderId?: string | null;
  razorpayPaymentId?: string | null;
}

async function fileCodOrder(auth: Authed, idempotencyKey?: string): Promise<{ res: any; order: OrderLike }> {
  const payload: Record<string, unknown> = {
    items: [{ productId: await seed16Id(), qty: 1 }],
    name: 'COD Person',
    email: auth.email,
    phone: '+91 98765 43210',
    address: { line: '1 Main Street', city: 'Mumbai', state: 'Maharashtra', pincode: '400001' },
    paymentMethod: 'cod',
  };
  if (idempotencyKey) payload.idempotencyKey = idempotencyKey;
  const res = await auth.agent
    .post('/api/v1/orders')
    .set('X-CSRF-Token', auth.csrfToken)
    .send(payload);
  expect(res.status).toBe(201);
  const order = res.body.data.order as OrderLike;
  ordersToCleanup.push(order.id);
  return { res, order };
}

async function cancelOrder(auth: Authed, orderId: string) {
  return auth.agent
    .post(`/api/v1/orders/${orderId}/cancel`)
    .set('X-CSRF-Token', auth.csrfToken)
    .send({ reason: 'CHANGED_MIND' });
}

async function adminSetFulfillment(auth: Authed, orderId: string, status: string, note?: string) {
  return auth.agent
    .patch(`/api/v1/admin/orders/${orderId}/fulfillment`)
    .set('X-CSRF-Token', auth.csrfToken)
    .send(note ? { status, note } : { status });
}

/* ------------------------------------------------------------------ */
/* COD order creation                                                  */
/* ------------------------------------------------------------------ */

describe('COD order creation', () => {
  it('produces status CONFIRMED, paymentMethod cod, fulfillment AWAITING_PAYMENT', async () => {
    const auth = await registerAgent('cod-create');
    const { order } = await fileCodOrder(auth);

    expect(order.status).toBe('CONFIRMED');
    expect(order.paymentMethod).toBe('cod');
    expect(order.fulfillmentStatus).toBe('AWAITING_PAYMENT');
    // Seeded price 7999 + flat 110 delivery (below the free-delivery threshold).
    expect(Number(order.subtotal)).toBe(SEED_PRICE);
    expect(Number(order.amount)).toBe(SEED_PRICE + 110);
    // COD must not carry a Razorpay order id (the createOrder select omits it).
    expect(order.razorpayOrderId).toBeFalsy();
  });

  it('creates no Razorpay order (no provider call)', async () => {
    const auth = await registerAgent('cod-no-razorpay');
    await fileCodOrder(auth);

    const razorpayCalls = fetchMock.mock.calls.filter(
      (args) => String(args[0]).includes('razorpay') || String(args[0]).includes('rzp.'),
    );
    expect(razorpayCalls).toHaveLength(0);
  });

  it('returns 422 for an invalid payment method', async () => {
    const auth = await registerAgent('cod-invalid');
    const res = await auth.agent
      .post('/api/v1/orders')
      .set('X-CSRF-Token', auth.csrfToken)
      .send({
        items: [{ productId: await seed16Id(), qty: 1 }],
        name: 'COD Person',
        email: auth.email,
        phone: '+91 98765 43210',
        address: { line: '1 Main Street', city: 'Mumbai', state: 'Maharashtra', pincode: '400001' },
        paymentMethod: 'bitcoin',
      });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('default online order stays REQUESTED with paymentMethod null', async () => {
    const auth = await registerAgent('cod-online-default');
    const res = await auth.agent
      .post('/api/v1/orders')
      .set('X-CSRF-Token', auth.csrfToken)
      .send({
        items: [{ productId: await seed16Id(), qty: 1 }],
        name: 'COD Person',
        email: auth.email,
        phone: '+91 98765 43210',
        address: { line: '1 Main Street', city: 'Mumbai', state: 'Maharashtra', pincode: '400001' },
      });
    expect(res.status).toBe(201);
    const order = res.body.data.order as OrderLike;
    ordersToCleanup.push(order.id);
    expect(order.status).toBe('REQUESTED');
    expect(order.paymentMethod).toBeNull();
    expect(order.fulfillmentStatus).toBe('AWAITING_PAYMENT');
  });
});

/* ------------------------------------------------------------------ */
/* Idempotency                                                         */
/* ------------------------------------------------------------------ */

describe('COD idempotency', () => {
  it('repeating the same idempotency key returns the same order (no duplicate)', async () => {
    const auth = await registerAgent('cod-idem');
    const key = `cod-idem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const { order: first } = await fileCodOrder(auth, key);

    // Replay with the same key.
    const res2 = await auth.agent
      .post('/api/v1/orders')
      .set('X-CSRF-Token', auth.csrfToken)
      .send({
        items: [{ productId: await seed16Id(), qty: 1 }],
        name: 'COD Person',
        email: auth.email,
        phone: '+91 98765 43210',
        address: { line: '1 Main Street', city: 'Mumbai', state: 'Maharashtra', pincode: '400001' },
        paymentMethod: 'cod',
        idempotencyKey: key,
      });
    expect(res2.status).toBe(200);
    expect(res2.body.data.idempotentReplay).toBe(true);
    expect(res2.body.data.order.id).toBe(first.id);
    expect(res2.body.data.order.orderNumber).toBe(first.orderNumber);

    // Only one order row should exist for this key.
    const { prisma } = await import('../src/lib/prisma.js');
    const count = await prisma.order.count({ where: { idempotencyKey: key } });
    expect(count).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* COD cancellation: no Razorpay refund                                */
/* ------------------------------------------------------------------ */

describe('COD cancellation', () => {
  it('customer cancels a COD order → CANCELLED, no Razorpay refund', async () => {
    const { prisma } = await import('../src/lib/prisma.js');
    const auth = await registerAgent('cod-cancel');
    const { order } = await fileCodOrder(auth);

    // Sanity: COD order is CONFIRMED, not PAID, so refund is never triggered.
    expect(order.status).toBe('CONFIRMED');

    const res = await cancelOrder(auth, order.id);
    expect(res.status).toBe(200);
    expect(res.body.data.order.status).toBe('CANCELLED');
    expect(res.body.data.order.fulfillmentStatus).toBe('CANCELLED');
    // No refund record for an unpaid (COD) order.
    expect(res.body.data.refund).toBeNull();

    // No Razorpay refund call should have been made.
    const refundCalls = fetchMock.mock.calls.filter(
      (args) => typeof args[0] === 'string' && args[0].includes('/refund'),
    );
    expect(refundCalls).toHaveLength(0);

    // No refund row in the DB either.
    const refundRows = await prisma.refund.count({ where: { orderId: order.id } });
    expect(refundRows).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* Admin fulfillment for COD                                           */
/* ------------------------------------------------------------------ */

describe('admin COD fulfillment', () => {
  it('advances a COD order from AWAITING_PAYMENT to PROCESSING', async () => {
    const auth = await registerAgent('cod-admin-fwd');
    const { order } = await fileCodOrder(auth);

    const admin = await getAdminAgent(app);
    const res = await adminSetFulfillment(admin, order.id, 'PROCESSING');
    expect(res.status).toBe(200);
    expect(res.body.data.order.fulfillmentStatus).toBe('PROCESSING');
    // COD order keeps its CONFIRMED payment status (not touched by fulfillment).
    expect(res.body.data.order.status).toBe('CONFIRMED');
  });

  it('cannot skip ahead from AWAITING_PAYMENT to SHIPPED', async () => {
    const auth = await registerAgent('cod-admin-skip');
    const { order } = await fileCodOrder(auth);

    const admin = await getAdminAgent(app);
    const res = await adminSetFulfillment(admin, order.id, 'SHIPPED');
    expect(res.status).toBe(409);
  });
});

/* ------------------------------------------------------------------ */
/* Online order payment gate (unchanged behaviour)                      */
/* ------------------------------------------------------------------ */

describe('online order payment gate', () => {
  it('an unpaid online order cannot advance to a fulfillment state requiring payment', async () => {
    const auth = await registerAgent('cod-online-gate');
    // File a default (online) order — status REQUESTED, paymentMethod null.
    const res = await auth.agent
      .post('/api/v1/orders')
      .set('X-CSRF-Token', auth.csrfToken)
      .send({
        items: [{ productId: await seed16Id(), qty: 1 }],
        name: 'Online Person',
        email: auth.email,
        phone: '+91 98765 43210',
        address: { line: '1 Main Street', city: 'Mumbai', state: 'Maharashtra', pincode: '400001' },
      });
    expect(res.status).toBe(201);
    const order = res.body.data.order as OrderLike;
    ordersToCleanup.push(order.id);
    expect(order.status).toBe('REQUESTED');

    const admin = await getAdminAgent(app);
    const fwd = await adminSetFulfillment(admin, order.id, 'PROCESSING');
    expect(fwd.status).toBe(409);
  });

  it('a COD order is exempt from the payment gate and can move to PROCESSING', async () => {
    const auth = await registerAgent('cod-exempt');
    const { order } = await fileCodOrder(auth);

    const admin = await getAdminAgent(app);
    // AWAITING_PAYMENT → PROCESSING is the forward transition and should succeed
    // without a verified payment because the order is COD.
    const res = await adminSetFulfillment(admin, order.id, 'PROCESSING');
    expect(res.status).toBe(200);
    expect(res.body.data.order.fulfillmentStatus).toBe('PROCESSING');
  });
});
