// Razorpay env must be set before src/config/env.ts is first imported, so the
// verified-payment path exercised below is available. Keep this import first.
import './helpers/razorpay-env.js';
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Express } from 'express';
import { createAgent, uniqueEmail, type AgentWithCsrf } from './helpers/agent.js';
import {
  getAdminAgent,
  ensureAdminUser,
  loginAgent,
  ADMIN_EMAIL,
  ADMIN_NAME,
  ADMIN_PASSWORD,
} from './helpers/admin.js';

const KEY_SECRET = 'dummy_key_secret_for_tests';
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

interface Authed extends AgentWithCsrf {
  email: string;
  userId: string;
}

async function registerAgent(prefix = 'admin'): Promise<Authed> {
  const { agent, csrfToken } = await createAgent(app);
  const email = uniqueEmail(prefix);
  const res = await agent
    .post('/api/v1/auth/register')
    .set('X-CSRF-Token', csrfToken)
    .send({ name: 'Test Person', email, password: 'testpassword1' });
  expect(res.status).toBe(201);
  return { agent, csrfToken, email, userId: res.body.data.user.id as string };
}

/** Sets the raw database role directly (to prove it can't grant admin). */
async function setDbRole(userId: string, role: 'CUSTOMER' | 'ADMIN'): Promise<void> {
  const { prisma } = await import('../src/lib/prisma.js');
  await prisma.user.update({ where: { id: userId }, data: { role } });
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
  fulfillmentStatus: string;
  paymentMethod?: string | null;
  razorpayPaymentId?: string | null;
  amount: number | string;
  items: Array<{ name: string; unitPrice: number }>;
  shipment?: { courierName: string | null; trackingNumber: string | null } | null;
}

async function fileOrder(auth: Authed): Promise<OrderLike> {
  const res = await auth.agent
    .post('/api/v1/orders')
    .set('X-CSRF-Token', auth.csrfToken)
    .send({
      items: [{ productId: await seed16Id(), qty: 1 }],
      name: 'Test Person',
      email: auth.email,
      phone: '+91 98765 43210',
      address: { line: '1 Main Street', city: 'Mumbai', state: 'Maharashtra', pincode: '400001' },
    });
  expect(res.status).toBe(201);
  return res.body.data.order as OrderLike;
}

/** Files a Cash on Delivery order (CONFIRMED, payment collected on delivery). */
async function fileCodOrder(auth: Authed): Promise<OrderLike> {
  const res = await auth.agent
    .post('/api/v1/orders')
    .set('X-CSRF-Token', auth.csrfToken)
    .send({
      items: [{ productId: await seed16Id(), qty: 1 }],
      name: 'Test Person',
      email: auth.email,
      phone: '+91 98765 43210',
      address: { line: '1 Main Street', city: 'Mumbai', state: 'Maharashtra', pincode: '400001' },
      paymentMethod: 'cod',
    });
  expect(res.status).toBe(201);
  return res.body.data.order as OrderLike;
}

async function payOrder(auth: Authed, orderId: string): Promise<OrderLike> {
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
    .send({ orderId });
  expect(initiated.status).toBe(201);

  const { buildPaymentSignature } = await import('../src/modules/payments/razorpay.js');
  const verified = await auth.agent
    .post('/api/v1/payments/razorpay/verify')
    .set('X-CSRF-Token', auth.csrfToken)
    .send({
      orderId,
      razorpayOrderId: providerOrderId,
      razorpayPaymentId: paymentId,
      razorpaySignature: buildPaymentSignature(providerOrderId, paymentId, KEY_SECRET),
    });
  expect(verified.status).toBe(200);
  return verified.body.data.order as OrderLike;
}

async function getAdminOrder(auth: Authed, id: string) {
  const res = await auth.agent.get(`/api/v1/admin/orders/${id}`);
  expect(res.status).toBe(200);
  return res.body.data.order;
}

async function setFulfillment(auth: Authed, id: string, status: string, note?: string) {
  return auth.agent
    .patch(`/api/v1/admin/orders/${id}/fulfillment`)
    .set('X-CSRF-Token', auth.csrfToken)
    .send(note ? { status, note } : { status });
}

/* ------------------------------------------------------------------ */
/* Authorization                                                       */
/* ------------------------------------------------------------------ */

describe('admin authorization is enforced server-side', () => {
  it('401s for guests', async () => {
    const { agent } = await createAgent(app);
    expect((await agent.get('/api/v1/admin/orders')).status).toBe(401);
  });

  it('403s for ordinary customers on every admin route', async () => {
    const customer = await registerAgent('customer');
    const order = await fileOrder(customer);

    expect((await customer.agent.get('/api/v1/admin/orders')).status).toBe(403);
    expect((await customer.agent.get(`/api/v1/admin/orders/${order.id}`)).status).toBe(403);
    expect((await setFulfillment(customer, order.id, 'PROCESSING')).status).toBe(403);
    expect(
      (
        await customer.agent
          .patch(`/api/v1/admin/orders/${order.id}/shipment`)
          .set('X-CSRF-Token', customer.csrfToken)
          .send({ trackingNumber: 'X' })
      ).status,
    ).toBe(403);
  });

  it('allows an admin', async () => {
    const admin = await getAdminAgent(app);
    expect((await admin.agent.get('/api/v1/admin/orders')).status).toBe(200);
  });
});

/* ------------------------------------------------------------------ */
/* Single-admin policy: email + verified identity, never DB role       */
/* ------------------------------------------------------------------ */

describe('single-admin policy', () => {
  it('denies a user whose database role is ADMIN but has a different email', async () => {
    const impostor = await registerAgent('impostor');
    await setDbRole(impostor.userId, 'ADMIN');

    // role='ADMIN' in the database must not grant access to any other email.
    expect((await impostor.agent.get('/api/v1/admin/orders')).status).toBe(403);
    const me = await impostor.agent.get('/api/v1/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.data.user.role).toBe('CUSTOMER');
  });

  it('denies the admin email while its email is not verified', async () => {
    const { prisma } = await import('../src/lib/prisma.js');
    await ensureAdminUser();
    await prisma.user.update({ where: { email: ADMIN_EMAIL }, data: { emailVerified: false } });
    try {
      const unverified = await loginAgent(app, ADMIN_EMAIL, ADMIN_PASSWORD);
      const me = await unverified.agent.get('/api/v1/auth/me');
      expect(me.body.data.user.role).toBe('CUSTOMER');
      expect((await unverified.agent.get('/api/v1/admin/orders')).status).toBe(403);
    } finally {
      await prisma.user.update({ where: { email: ADMIN_EMAIL }, data: { emailVerified: true } });
    }
  });

  it('logging out clears the admin session immediately', async () => {
    await ensureAdminUser();
    const admin = await loginAgent(app, ADMIN_EMAIL, ADMIN_PASSWORD);
    expect((await admin.agent.get('/api/v1/admin/orders')).status).toBe(200);

    const out = await admin.agent
      .post('/api/v1/auth/logout')
      .set('X-CSRF-Token', admin.csrfToken);
    expect(out.status).toBe(200);

    // Both the admin API and the session identity are gone right away.
    expect((await admin.agent.get('/api/v1/admin/orders')).status).toBe(401);
    expect((await admin.agent.get('/api/v1/auth/me')).status).toBe(401);
  });

  it('preserves customer orders and addresses when admin roles are revoked', async () => {
    const { revokeNonAuthorizedAdminRoles } = await import('../src/modules/auth/authorization.js');
    const { prisma } = await import('../src/lib/prisma.js');

    const customer = await registerAgent('preserve');
    const order = await fileOrder(customer);
    const addr = await customer.agent
      .post('/api/v1/addresses')
      .set('X-CSRF-Token', customer.csrfToken)
      .send({
        label: 'Home',
        line: '1 Main Street',
        city: 'Mumbai',
        state: 'Maharashtra',
        pincode: '400001',
      });
    expect(addr.status).toBe(201);

    // They wrongly held an admin DB role; revoke it (non-destructively).
    await setDbRole(customer.userId, 'ADMIN');
    const revoked = await revokeNonAuthorizedAdminRoles();
    expect(revoked).toBeGreaterThanOrEqual(1);

    const after = await prisma.user.findUnique({
      where: { id: customer.userId },
      select: { role: true },
    });
    expect(after?.role).toBe('CUSTOMER');

    // Orders and addresses are intact and still readable by their owner.
    const orders = await customer.agent.get('/api/v1/orders');
    expect(orders.status).toBe(200);
    expect((orders.body.data.orders as OrderLike[]).some((o) => o.id === order.id)).toBe(true);

    const addresses = await customer.agent.get('/api/v1/addresses');
    expect(addresses.status).toBe(200);
    expect(
      (addresses.body.data.addresses as Array<{ line: string }>).some(
        (a) => a.line === '1 Main Street',
      ),
    ).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* List, search, filters, privacy                                      */
/* ------------------------------------------------------------------ */

describe('admin order list', () => {
  it('lists orders belonging to other customers and finds one by order number', async () => {
    const owner = await registerAgent('owner');
    const order = await fileOrder(owner);

    const admin = await getAdminAgent(app);

    const list = await admin.agent.get('/api/v1/admin/orders?limit=100');
    expect(list.status).toBe(200);
    const ids = (list.body.data.orders as OrderLike[]).map((o) => o.id);
    expect(ids).toContain(order.id);

    const search = await admin.agent.get(`/api/v1/admin/orders?q=${order.orderNumber}`);
    expect(search.status).toBe(200);
    const found = search.body.data.orders as OrderLike[];
    expect(found.some((o) => o.id === order.id)).toBe(true);
  });

  it('filters by payment status', async () => {
    const paidOwner = await registerAgent('paid');
    const paid = await payOrder(paidOwner, (await fileOrder(paidOwner)).id);
    expect(paid.status).toBe('PAID');

    const admin = await getAdminAgent(app);

    const res = await admin.agent.get('/api/v1/admin/orders?paymentStatus=PAID&limit=100');
    expect(res.status).toBe(200);
    for (const o of res.body.data.orders as OrderLike[]) {
      expect(o.status).toBe('PAID');
    }
  });

  it('rejects an unknown filter value with 422', async () => {
    const admin = await getAdminAgent(app);
    expect((await admin.agent.get('/api/v1/admin/orders?paymentStatus=NOPE')).status).toBe(422);
  });
});

/* ------------------------------------------------------------------ */
/* Fulfilment workflow + payment/shipment separation                   */
/* ------------------------------------------------------------------ */

describe('fulfilment workflow', () => {
  it('cannot leave awaiting payment before payment is verified', async () => {
    const user = await registerAgent('wf');
    const order = await fileOrder(user);
    const admin = await getAdminAgent(app);

    expect(order.fulfillmentStatus).toBe('AWAITING_PAYMENT');
    const res = await setFulfillment(admin, order.id, 'PROCESSING');
    expect(res.status).toBe(409);
  });

  it('advances a paid order through the stages but forbids skipping', async () => {
    const user = await registerAgent('wf');
    const order = await fileOrder(user);
    await payOrder(user, order.id);

    const admin = await getAdminAgent(app);

    const afterPay = await getAdminOrder(admin, order.id);
    expect(afterPay.status).toBe('PAID');
    expect(afterPay.fulfillmentStatus).toBe('PROCESSING');

    // Skipping ahead is rejected.
    expect((await setFulfillment(admin, order.id, 'DELIVERED')).status).toBe(409);

    for (const next of ['READY_TO_SHIP', 'SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED']) {
      const res = await setFulfillment(admin, order.id, next);
      expect(res.status).toBe(200);
      expect(res.body.data.order.fulfillmentStatus).toBe(next);
    }

    // Terminal state: no further transitions.
    expect((await setFulfillment(admin, order.id, 'PROCESSING')).status).toBe(409);
  });

  it('cancels an unpaid order (and its payment status)', async () => {
    const user = await registerAgent('wf');
    const order = await fileOrder(user);
    const admin = await getAdminAgent(app);

    const res = await setFulfillment(admin, order.id, 'CANCELLED', 'Customer asked to cancel');
    expect(res.status).toBe(200);
    expect(res.body.data.order.fulfillmentStatus).toBe('CANCELLED');
    expect(res.body.data.order.status).toBe('CANCELLED');
  });

  it('keeps payment status PAID when a paid order is cancelled (separation)', async () => {
    const user = await registerAgent('wf');
    const order = await fileOrder(user);
    await payOrder(user, order.id);

    const admin = await getAdminAgent(app);

    const res = await setFulfillment(admin, order.id, 'CANCELLED');
    expect(res.status).toBe(200);
    expect(res.body.data.order.fulfillmentStatus).toBe('CANCELLED');
    // Shipment cancelled, payment record untouched.
    expect(res.body.data.order.status).toBe('PAID');
  });
});

/* ------------------------------------------------------------------ */
/* Shipment / tracking                                                 */
/* ------------------------------------------------------------------ */

describe('shipment tracking details', () => {
  it('refuses shipment details for an unpaid order', async () => {
    const user = await registerAgent('ship');
    const order = await fileOrder(user);
    const admin = await getAdminAgent(app);

    const res = await admin.agent
      .patch(`/api/v1/admin/orders/${order.id}/shipment`)
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ courierName: 'Delhivery', trackingNumber: 'DLV123' });
    expect(res.status).toBe(409);
    // The order is online and unpaid: payment must be verified first.
    expect((await getAdminOrder(admin, order.id)).status).not.toBe('PAID');
  });

  it('allows a confirmed COD order to be shipped while payment stays unpaid', async () => {
    const user = await registerAgent('ship-cod');
    const order = await fileCodOrder(user);
    expect(order.status).toBe('CONFIRMED');
    expect(order.paymentMethod).toBe('cod');

    const admin = await getAdminAgent(app);

    const res = await admin.agent
      .patch(`/api/v1/admin/orders/${order.id}/shipment`)
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ courierName: 'Delhivery', trackingNumber: 'COD-AWB-1' });
    expect(res.status).toBe(200);
    expect(res.body.data.shipment.trackingNumber).toBe('COD-AWB-1');

    // Payment is never marked paid just to permit shipment: the order stays
    // CONFIRMED with no verified payment record.
    const detail = await getAdminOrder(admin, order.id);
    expect(detail.status).toBe('CONFIRMED');
    expect(detail.razorpayPaymentId).toBeNull();
  });

  it('refuses shipment details for a cancelled order', async () => {
    const user = await registerAgent('ship-cancel');
    const order = await fileOrder(user);
    const admin = await getAdminAgent(app);

    const cancelled = await setFulfillment(admin, order.id, 'CANCELLED');
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data.order.fulfillmentStatus).toBe('CANCELLED');

    const res = await admin.agent
      .patch(`/api/v1/admin/orders/${order.id}/shipment`)
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ courierName: 'Delhivery', trackingNumber: 'NOPE-1' });
    expect(res.status).toBe(409);
    expect((await getAdminOrder(admin, order.id)).shipment).toBeNull();
  });

  it('saves a tracking number + URL for a paid order and shows it to the customer', async () => {
    const user = await registerAgent('ship');
    const order = await fileOrder(user);
    await payOrder(user, order.id);

    const admin = await getAdminAgent(app);

    const save = await admin.agent
      .patch(`/api/v1/admin/orders/${order.id}/shipment`)
      .set('X-CSRF-Token', admin.csrfToken)
      .send({
        courierName: 'Delhivery',
        trackingNumber: 'DLV-123456',
        trackingUrl: 'https://www.delhivery.com/track/package/DLV-123456',
        dispatchNotes: 'Handed to pickup agent',
      });
    expect(save.status).toBe(200);
    expect(save.body.data.shipment.trackingNumber).toBe('DLV-123456');

    // The customer sees the shipment on their own order (My Orders detail).
    const customerView = await user.agent.get(`/api/v1/orders/by-number/${order.orderNumber}`);
    expect(customerView.status).toBe(200);
    expect(customerView.body.data.order.shipment.trackingNumber).toBe('DLV-123456');
    expect(customerView.body.data.order.shipment.courierName).toBe('Delhivery');
    // The DRAFTOX number is never replaced by the courier AWB.
    expect(customerView.body.data.order.orderNumber).toBe(order.orderNumber);
  });

  it('rejects an invalid tracking URL', async () => {
    const user = await registerAgent('ship');
    const order = await fileOrder(user);
    await payOrder(user, order.id);
    const admin = await getAdminAgent(app);

    const res = await admin.agent
      .patch(`/api/v1/admin/orders/${order.id}/shipment`)
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ trackingNumber: 'DLV1', trackingUrl: 'not-a-url' });
    expect(res.status).toBe(422);
  });
});

/* ------------------------------------------------------------------ */
/* Order history                                                       */
/* ------------------------------------------------------------------ */

describe('order history', () => {
  it('records creation, verified payment, fulfilment and shipment events', async () => {
    const user = await registerAgent('hist');
    const order = await fileOrder(user);
    await payOrder(user, order.id);

    const admin = await getAdminAgent(app);

    await setFulfillment(admin, order.id, 'READY_TO_SHIP', 'Packing complete');
    await admin.agent
      .patch(`/api/v1/admin/orders/${order.id}/shipment`)
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ courierName: 'Delhivery', trackingNumber: 'DLV-HIST' });

    const detail = await getAdminOrder(admin, order.id);
    const events = detail.events as Array<{ type: string; actorName: string | null }>;
    const types = events.map((e) => e.type);
    expect(types).toContain('ORDER_CREATED');
    expect(types).toContain('PAYMENT_VERIFIED');
    expect(types).toContain('FULFILLMENT_CHANGED');
    expect(types).toContain('SHIPMENT_UPDATED');

    // The admin's manual fulfilment move is attributed to the acting admin
    // (the automatic post-payment move has no actor).
    const adminFulfilmentEvent = events.find(
      (e) => e.type === 'FULFILLMENT_CHANGED' && e.actorName,
    );
    expect(adminFulfilmentEvent?.actorName).toBe(ADMIN_NAME);
  });
});
