// Must stay the first import: enables Razorpay (via env helper) so the
// verified-payment path can run and a shipment can be recorded.
import './helpers/razorpay-env.js';
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Express } from 'express';
import { createAgent, uniqueEmail, type AgentWithCsrf } from './helpers/agent.js';
import { getAdminAgent } from './helpers/admin.js';

// Mock the mailer module so tests never touch real SMTP. The mock records
// every call so we can assert recipient/subject/error behaviour.
let mailCalls: Array<{ to: string; subject: string; html: string; text: string }> = [];
vi.mock('../src/lib/mailer.js', () => ({
  sendMail: (input: { to: string; subject: string; html: string; text: string }) => {
    mailCalls.push(input);
    return Promise.resolve({ accepted: true, messageId: 'mock-msg-id', error: null });
  },
  isMailerReady: true,
}));

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
  mailCalls = [];
});

afterAll(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(payload: unknown, ok = true) {
  return Promise.resolve({ ok, status: ok ? 200 : 400, json: async () => payload });
}

interface Authed extends AgentWithCsrf {
  email: string;
  userId: string;
}

interface OrderLike {
  id: string;
  orderNumber: string | null;
  status: string;
  fulfillmentStatus: string;
  email: string;
  shipment?: {
    courierName: string | null;
    trackingNumber: string | null;
    trackingUrl: string | null;
    trackingToken: string | null;
  } | null;
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

async function registerAgent(prefix = 'track'): Promise<Authed> {
  const { agent, csrfToken } = await createAgent(app);
  const email = uniqueEmail(prefix);
  const res = await agent
    .post('/api/v1/auth/register')
    .set('X-CSRF-Token', csrfToken)
    .send({ name: 'Test Person', email, password: 'testpassword1' });
  expect(res.status).toBe(201);
  return { agent, csrfToken, email, userId: res.body.data.user.id as string };
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

async function payOrder(auth: Authed, orderId: string): Promise<OrderLike> {
  const providerOrderId = `order_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const paymentId = `pay_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
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

async function saveShipment(admin: Authed, orderId: string, input: Record<string, unknown>) {
  return admin.agent
    .patch(`/api/v1/admin/orders/${orderId}/shipment`)
    .set('X-CSRF-Token', admin.csrfToken)
    .send(input);
}

/* ------------------------------------------------------------------ */
/* Public tracking route                                                */
/* ------------------------------------------------------------------ */

describe('public tracking route', () => {
  it('404s for a token that does not exist', async () => {
    const { agent } = await createAgent(app);
    const res = await agent.get('/api/v1/track/nonexistent-token-12345');
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('returns shipment details for a token, with no PII', async () => {
    const customer = await registerAgent('track-pii');
    const order = await fileOrder(customer);
    await payOrder(customer, order.id);

    const admin = await getAdminAgent(app);

    const saved = await saveShipment(admin, order.id, {
      courierName: 'Delhivery',
      trackingNumber: 'DLV-123456',
      trackingUrl: 'https://www.delhivery.com/track/package/DLV-123456',
    });
    expect(saved.status).toBe(200);
    const token = saved.body.data.shipment.trackingToken;
    expect(token).toBeTruthy();

    // Public lookup (no auth cookies).
    const { agent: anon } = await createAgent(app);
    const res = await anon.get(`/api/v1/track/${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.orderNumber).toBe(order.orderNumber);
    expect(res.body.data.courierName).toBe('Delhivery');
    expect(res.body.data.trackingNumber).toBe('DLV-123456');
    expect(res.body.data.trackingUrl).toBe('https://www.delhivery.com/track/package/DLV-123456');

    // PII must never be exposed on the public endpoint.
    expect(res.body.data).not.toHaveProperty('email');
    expect(res.body.data).not.toHaveProperty('phone');
    expect(res.body.data).not.toHaveProperty('address');
    expect(JSON.stringify(res.body.data)).not.toContain('@example.com');
  });

  it('generates a stable tracking token (unchanged across edits)', async () => {
    const customer = await registerAgent('track-stable');
    const order = await fileOrder(customer);
    await payOrder(customer, order.id);

    const admin = await getAdminAgent(app);

    const first = await saveShipment(admin, order.id, {
      courierName: 'Delhivery',
      trackingNumber: 'DLV-001',
    });
    expect(first.status).toBe(200);
    const tokenA = first.body.data.shipment.trackingToken;

    const second = await saveShipment(admin, order.id, { trackingNumber: 'DLV-002' });
    expect(second.status).toBe(200);
    const tokenB = second.body.data.shipment.trackingToken;

    expect(tokenB).toBe(tokenA);
  });
});

/* ------------------------------------------------------------------ */
/* Initial shipment email (idempotent)                                  */
/* ------------------------------------------------------------------ */

describe('initial shipment email (idempotent)', () => {
  it('creates a notification and sends the initial email when shipment is saved', async () => {
    const customer = await registerAgent('track-email');
    const order = await fileOrder(customer);
    await payOrder(customer, order.id);

    const admin = await getAdminAgent(app);

    const res = await saveShipment(admin, order.id, {
      courierName: 'Delhivery',
      trackingNumber: 'DLV-EMAIL',
    });
    expect(res.status).toBe(200);
    expect(res.body.data.initialEmailSent).toBe(true);

    // An email was captured by the mock.
    expect(mailCalls.length).toBe(1);
    expect(mailCalls[0].to).toBe(order.email);
    expect(mailCalls[0].subject).toContain('has shipped');

    // The notification row exists and is marked SENT.
    const { prisma } = await import('../src/lib/prisma.js');
    const notif = await prisma.shipmentNotification.findFirst({
      where: { orderId: order.id, type: 'INITIAL' },
      select: { status: true, toEmail: true, provider: true },
    });
    expect(notif).not.toBeNull();
    expect(notif!.status).toBe('SENT');
    expect(notif!.toEmail).toBe(order.email);
    expect(notif!.provider).toBe('smtp');
  });

  it('only ever creates one INITIAL notification per order', async () => {
    const customer = await registerAgent('track-dedup');
    const order = await fileOrder(customer);
    await payOrder(customer, order.id);

    const admin = await getAdminAgent(app);

    await saveShipment(admin, order.id, { courierName: 'Delhivery', trackingNumber: 'DLV-001' });
    await saveShipment(admin, order.id, { courierName: 'DTDC', trackingNumber: 'DTDC-002' });

    const { prisma } = await import('../src/lib/prisma.js');
    const count = await prisma.shipmentNotification.count({
      where: { orderId: order.id, type: 'INITIAL' },
    });
    expect(count).toBe(1);
    // But the second save should NOT trigger another email.
    expect(mailCalls.length).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* Notification retry                                                   */
/* ------------------------------------------------------------------ */

describe('notification retry', () => {
  it('never re-sends an already-accepted notification (duplicate guard)', async () => {
    const customer = await registerAgent('track-retry');
    const order = await fileOrder(customer);
    await payOrder(customer, order.id);

    const admin = await getAdminAgent(app);

    await saveShipment(admin, order.id, {
      courierName: 'Delhivery',
      trackingNumber: 'DLV-RETRY',
    });

    expect(mailCalls.length).toBe(1);

    const { prisma } = await import('../src/lib/prisma.js');
    const notif = await prisma.shipmentNotification.findFirst({
      where: { orderId: order.id, type: 'INITIAL' },
      select: { id: true },
    });
    expect(notif).not.toBeNull();

    // The INITIAL email was accepted; retrying must NOT send a duplicate.
    const retry = await admin.agent
      .post(`/api/v1/admin/notifications/${notif!.id}/retry`)
      .set('X-CSRF-Token', admin.csrfToken);
    expect(retry.status).toBe(200);
    expect(retry.body.data.status).toBe('ALREADY_SENT');
    expect(retry.body.data.sent).toBe(false);

    // Still exactly one email: no duplicate.
    expect(mailCalls.length).toBe(1);

    const after = await prisma.shipmentNotification.findUnique({
      where: { id: notif!.id },
      select: { status: true, attempts: true, messageId: true },
    });
    expect(after?.status).toBe('SENT');
    expect(after?.attempts).toBe(1);
    expect(after?.messageId).toBe('mock-msg-id');
  });

  it('404s for an unknown notification id', async () => {
    const admin = await getAdminAgent(app);

    const res = await admin.agent
      .post('/api/v1/admin/notifications/nonexistent-notif-id/retry')
      .set('X-CSRF-Token', admin.csrfToken);
    expect(res.status).toBe(404);
  });
});

/* ------------------------------------------------------------------ */
/* Send tracking update email                                           */
/* ------------------------------------------------------------------ */

describe('send tracking update email', () => {
  it('409s when no shipment token exists', async () => {
    const customer = await registerAgent('track-update');
    const order = await fileOrder(customer);
    await payOrder(customer, order.id);

    const admin = await getAdminAgent(app);

    const res = await admin.agent
      .post(`/api/v1/admin/orders/${order.id}/shipment/email`)
      .set('X-CSRF-Token', admin.csrfToken);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('sends an UPDATE email for a paid order with a shipment', async () => {
    const customer = await registerAgent('track-update2');
    const order = await fileOrder(customer);
    await payOrder(customer, order.id);

    const admin = await getAdminAgent(app);

    await saveShipment(admin, order.id, {
      courierName: 'Delhivery',
      trackingNumber: 'DLV-UPDATE',
    });

    // After the initial save, there should be 1 email (the INITIAL).
    expect(mailCalls.length).toBe(1);

    const res = await admin.agent
      .post(`/api/v1/admin/orders/${order.id}/shipment/email`)
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ note: 'Out for delivery today' });
    expect(res.status).toBe(200);
    expect(res.body.data.notificationId).toBeTruthy();

    // A second email was sent (the UPDATE).
    expect(mailCalls.length).toBe(2);
    const updateEmail = mailCalls[mailCalls.length - 1];
    expect(updateEmail.to).toBe(order.email);
    expect(updateEmail.subject).toMatch(/Update on your DRAFTOX order/);

    const { prisma } = await import('../src/lib/prisma.js');
    const notifs = await prisma.shipmentNotification.findMany({
      where: { orderId: order.id, type: 'UPDATE' },
      select: { status: true, messageId: true },
    });
    expect(notifs.length).toBe(1);
    expect(notifs[0].status).toBe('SENT');
  });
});
