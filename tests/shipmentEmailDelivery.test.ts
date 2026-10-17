// Razorpay env must be set before src/config/env.ts is first imported so a
// verified payment (a prerequisite for a shipment) can run. Keep this first.
import './helpers/razorpay-env.js';
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Express } from 'express';
import { createAgent, uniqueEmail, type AgentWithCsrf } from './helpers/agent.js';
import { getAdminAgent, SUPPORT_EMAIL } from './helpers/admin.js';

// Controllable mailer mock. `isMailerReady` is a live getter so a test can
// simulate "provider not configured" and `sendMail` is a spy whose
// acceptance/failure each test controls. No real SMTP is ever touched.
const mailer = vi.hoisted(() => ({
  isReady: true,
  sendMail: vi.fn(),
}));

vi.mock('../src/lib/mailer.js', () => ({
  get isMailerReady() {
    return mailer.isReady;
  },
  sendMail: (input: unknown) => mailer.sendMail(input),
}));

const KEY_SECRET = 'dummy_key_secret_for_tests';
const SEED_PRICE = 7999;
// Single-unit 16-channel order total: catalog price + flat delivery fee.
const SEED_TOTAL = SEED_PRICE + 110;
const ADMIN_EMAIL = 'draftox0@gmail.com';

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
  mailer.sendMail.mockReset();
  mailer.isReady = true;
  mailer.sendMail.mockResolvedValue({ accepted: true, messageId: 'mid-default', error: null });
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
  shipment?: { trackingNumber: string | null; trackingToken: string | null } | null;
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

async function registerAgent(prefix = 'email'): Promise<Authed> {
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

async function payOrder(auth: Authed, orderId: string): Promise<void> {
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
}

async function paidOrder(): Promise<{ customer: Authed; order: OrderLike; admin: Authed }> {
  const customer = await registerAgent();
  const order = await fileOrder(customer);
  await payOrder(customer, order.id);
  const admin = await getAdminAgent(app);
  return { customer, order, admin };
}

function saveShipment(admin: Authed, orderId: string, input: Record<string, unknown>) {
  return admin.agent
    .patch(`/api/v1/admin/orders/${orderId}/shipment`)
    .set('X-CSRF-Token', admin.csrfToken)
    .send(input);
}

const shipmentInput = {
  courierName: 'Delhivery',
  trackingNumber: 'DLV-EMAIL-1',
  trackingUrl: 'https://www.delhivery.com/track/package/DLV-EMAIL-1',
};

/* ------------------------------------------------------------------ */
/* Truthful save + email status                                        */
/* ------------------------------------------------------------------ */

describe('shipment save reports email delivery truthfully', () => {
  it('reports SENT only when the provider accepts the message', async () => {
    const { order, admin } = await paidOrder();

    const res = await saveShipment(admin, order.id, shipmentInput);
    expect(res.status).toBe(200);

    // Shipment saved.
    expect(res.body.data.shipment.trackingNumber).toBe('DLV-EMAIL-1');
    // Email accepted by the (mocked) provider.
    expect(res.body.data.initialEmailSent).toBe(true);
    expect(res.body.data.email.status).toBe('SENT');
    expect(res.body.data.email.sent).toBe(true);
    expect(res.body.data.email.notificationId).toBeTruthy();

    expect(mailer.sendMail).toHaveBeenCalledTimes(1);

    const { prisma } = await import('../src/lib/prisma.js');
    const notif = await prisma.shipmentNotification.findFirst({
      where: { orderId: order.id, type: 'INITIAL' },
      select: { status: true, toEmail: true, provider: true, attempts: true },
    });
    expect(notif?.status).toBe('SENT');
    expect(notif?.toEmail).toBe(order.email);
    expect(notif?.provider).toBe('smtp');
    expect(notif?.attempts).toBe(1);
  });

  it('sends to the order\u2019s registered email with the order number, tracking link and support address', async () => {
    const { order, admin } = await paidOrder();
    const res = await saveShipment(admin, order.id, shipmentInput);
    expect(res.status).toBe(200);

    const token = res.body.data.shipment.trackingToken as string;
    expect(token).toBeTruthy();

    const call = mailer.sendMail.mock.calls[0][0] as {
      to: string;
      subject: string;
      html: string;
      text: string;
      from?: string;
    };

    // Recipient is the CUSTOMER'S registered email on the order — never the
    // admin or the support/shipping sender account.
    expect(call.to).toBe(order.email);
    expect(call.to.toLowerCase()).not.toBe(ADMIN_EMAIL);
    expect(call.to.toLowerCase()).not.toBe(SUPPORT_EMAIL);
    // The sender (From) is applied centrally by the mailer from EMAIL_FROM /
    // SMTP_USER; notification messages themselves never override it.
    expect(call.from).toBeUndefined();

    expect(call.subject).toContain(order.orderNumber!);
    expect(call.html).toContain(`/track/${encodeURIComponent(token)}`);
    expect(call.html).toContain('DRAFTOX');
    expect(call.html).toContain(SUPPORT_EMAIL);
    expect(call.html).toContain('DLV-EMAIL-1');
    expect(call.text).toContain(order.orderNumber!);
    expect(call.text).toContain(SUPPORT_EMAIL);
  });

  it('keeps the shipment saved when the provider rejects the email', async () => {
    const { customer, order, admin } = await paidOrder();
    mailer.sendMail.mockResolvedValueOnce({
      accepted: false,
      messageId: null,
      error: 'smtp 550 mailbox unavailable',
    });

    const res = await saveShipment(admin, order.id, shipmentInput);
    expect(res.status).toBe(200);

    // The shipment must survive an email failure.
    expect(res.body.data.shipment.trackingNumber).toBe('DLV-EMAIL-1');
    expect(res.body.data.initialEmailSent).toBe(false);
    expect(res.body.data.email.status).toBe('FAILED');
    expect(res.body.data.email.sent).toBe(false);
    expect(res.body.data.email.error).toContain('550');

    // The customer still sees the shipment on their own order.
    const view = await customer.agent.get(`/api/v1/orders/by-number/${order.orderNumber}`);
    expect(view.status).toBe(200);
    expect(view.body.data.order.shipment.trackingNumber).toBe('DLV-EMAIL-1');

    const { prisma } = await import('../src/lib/prisma.js');
    const notif = await prisma.shipmentNotification.findFirst({
      where: { orderId: order.id, type: 'INITIAL' },
      select: { status: true, error: true },
    });
    expect(notif?.status).toBe('FAILED');
    expect(notif?.error).toContain('550');
  });

  it('reports NOT_CONFIGURED and saves the shipment when no provider is configured', async () => {
    const { order, admin } = await paidOrder();
    mailer.isReady = false;

    const res = await saveShipment(admin, order.id, shipmentInput);
    expect(res.status).toBe(200);
    expect(res.body.data.shipment.trackingNumber).toBe('DLV-EMAIL-1');
    expect(res.body.data.initialEmailSent).toBe(false);
    expect(res.body.data.email.status).toBe('NOT_CONFIGURED');
    // No send was even attempted.
    expect(mailer.sendMail).not.toHaveBeenCalled();

    const { prisma } = await import('../src/lib/prisma.js');
    const notif = await prisma.shipmentNotification.findFirst({
      where: { orderId: order.id, type: 'INITIAL' },
      select: { status: true, provider: true },
    });
    expect(notif?.status).toBe('PENDING');
    expect(notif?.provider).toBeNull();
  });

  it('reports NO_RECIPIENT when the order has no customer email', async () => {
    const { order, admin } = await paidOrder();
    const { prisma } = await import('../src/lib/prisma.js');
    await prisma.order.update({ where: { id: order.id }, data: { email: '' } });

    const res = await saveShipment(admin, order.id, shipmentInput);
    expect(res.status).toBe(200);
    expect(res.body.data.email.status).toBe('NO_RECIPIENT');
    expect(res.body.data.email.sent).toBe(false);
    expect(mailer.sendMail).not.toHaveBeenCalled();
  });

  it('does not send an automatic email on later edits of the same shipment', async () => {
    const { order, admin } = await paidOrder();
    await saveShipment(admin, order.id, shipmentInput);
    expect(mailer.sendMail).toHaveBeenCalledTimes(1);

    const second = await saveShipment(admin, order.id, { trackingNumber: 'DLV-EMAIL-2' });
    expect(second.status).toBe(200);
    expect(second.body.data.email.status).toBe('SKIPPED');
    expect(mailer.sendMail).toHaveBeenCalledTimes(1);
  });
});

/* ------------------------------------------------------------------ */
/* Slow provider must not roll back the parent record                  */
/* ------------------------------------------------------------------ */

describe('slow provider never rolls back the parent record', () => {
  it('keeps the shipment and the outbox row when the send outlives a DB transaction timeout', async () => {
    const { order, admin } = await paidOrder();

    // Simulate a Gmail SMTP round-trip that exceeds Prisma's default 5s
    // interactive-transaction timeout. Regression: before the fix the shipment
    // save ran the send INSIDE its transaction, so the transaction expired
    // mid-send and rolled the shipment (and the outbox row) back.
    mailer.sendMail.mockImplementationOnce(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ accepted: true, messageId: 'slow-mid', error: null }), 5500),
        ),
    );

    const res = await saveShipment(admin, order.id, shipmentInput);
    expect(res.status).toBe(200);
    expect(res.body.data.shipment.trackingNumber).toBe('DLV-EMAIL-1');
    expect(res.body.data.email.status).toBe('SENT');

    const { prisma } = await import('../src/lib/prisma.js');
    const notif = await prisma.shipmentNotification.findFirst({
      where: { orderId: order.id, type: 'INITIAL' },
      select: { status: true, attempts: true },
    });
    expect(notif?.status).toBe('SENT');
    expect(notif?.attempts).toBe(1);

    const shipment = await prisma.shipment.findUnique({
      where: { orderId: order.id },
      select: { trackingNumber: true },
    });
    expect(shipment?.trackingNumber).toBe('DLV-EMAIL-1');
  }, 20000);

  it('keeps the COD order confirmed and records the confirmation outbox row when the send outlives the timeout', async () => {
    const customer = await registerAgent('cod-slow');

    mailer.sendMail.mockImplementationOnce(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ accepted: true, messageId: 'slow-cod', error: null }), 5500),
        ),
    );

    const res = await customer.agent
      .post('/api/v1/orders')
      .set('X-CSRF-Token', customer.csrfToken)
      .send({
        items: [{ productId: await seed16Id(), qty: 1 }],
        name: 'Test Person',
        email: customer.email,
        phone: '+91 98765 43210',
        address: { line: '1 Main Street', city: 'Mumbai', state: 'Maharashtra', pincode: '400001' },
        paymentMethod: 'cod',
      });
    expect(res.status).toBe(201);
    const orderId = res.body.data.order.id as string;
    expect(res.body.data.order.status).toBe('CONFIRMED');

    const { prisma } = await import('../src/lib/prisma.js');
    const notif = await prisma.orderNotification.findFirst({
      where: { orderId, type: 'ORDER_CONFIRMED' },
      select: { status: true, attempts: true },
    });
    expect(notif?.status).toBe('SENT');
    expect(notif?.attempts).toBe(1);
  }, 20000);
});

/* ------------------------------------------------------------------ */
/* Authorization                                                       */
/* ------------------------------------------------------------------ */

describe('shipment email authorization', () => {
  it('403s an ordinary customer and never sends on their behalf', async () => {
    const customer = await registerAgent('notadmin');
    const order = await fileOrder(customer);
    await payOrder(customer, order.id);

    const res = await customer.agent
      .patch(`/api/v1/admin/orders/${order.id}/shipment`)
      .set('X-CSRF-Token', customer.csrfToken)
      .send(shipmentInput);
    expect(res.status).toBe(403);
    expect(mailer.sendMail).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/* COD tracking updates (order stays CONFIRMED/unpaid)                 */
/* ------------------------------------------------------------------ */

async function fileCodOrder(customer: Authed): Promise<OrderLike> {
  const res = await customer.agent
    .post('/api/v1/orders')
    .set('X-CSRF-Token', customer.csrfToken)
    .send({
      items: [{ productId: await seed16Id(), qty: 1 }],
      name: 'Test Person',
      email: customer.email,
      phone: '+91 98765 43210',
      address: { line: '1 Main Street', city: 'Mumbai', state: 'Maharashtra', pincode: '400001' },
      paymentMethod: 'cod',
    });
  expect(res.status).toBe(201);
  return res.body.data.order as OrderLike;
}

describe('COD order tracking updates', () => {
  it('emails a tracking update for a confirmed COD order while payment stays unpaid', async () => {
    const customer = await registerAgent('cod-ship');
    const order = await fileCodOrder(customer);
    expect(order.status).toBe('CONFIRMED');

    const admin = await getAdminAgent(app);
    const saved = await saveShipment(admin, order.id, shipmentInput);
    expect(saved.status).toBe(200);

    const res = await admin.agent
      .post(`/api/v1/admin/orders/${order.id}/shipment/email`)
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ note: 'Out for delivery' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('SENT');
    expect(mailer.sendMail).toHaveBeenCalled();

    // COD is never treated as an online payment: the order stays CONFIRMED.
    const view = await customer.agent.get(`/api/v1/orders/${order.id}`);
    expect(view.body.data.order.status).toBe('CONFIRMED');
    expect(view.body.data.order.razorpayPaymentId).toBeFalsy();
  });

  it('still refuses a tracking update for an unpaid online (non-COD) order', async () => {
    const customer = await registerAgent('unpaid-online');
    const order = await fileOrder(customer);
    expect(order.status).toBe('REQUESTED');

    // Seed a shipment token directly so the only thing that can block the send
    // is the payment gate, not a missing shipment.
    const { prisma } = await import('../src/lib/prisma.js');
    await prisma.shipment.create({
      data: {
        orderId: order.id,
        courierName: 'Delhivery',
        trackingNumber: 'UNPAID-AWB-1',
        trackingToken: `tok_${Date.now()}_unpaid`,
      },
    });

    const admin = await getAdminAgent(app);
    const res = await admin.agent
      .post(`/api/v1/admin/orders/${order.id}/shipment/email`)
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ note: 'Out for delivery' });
    expect(res.status).toBe(409);
    expect(mailer.sendMail).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/* Retry + duplicate prevention                                        */
/* ------------------------------------------------------------------ */

describe('safe retry and duplicate prevention', () => {
  it('retries a FAILED notification to success, then refuses to duplicate it', async () => {
    const { order, admin } = await paidOrder();
    mailer.sendMail.mockResolvedValueOnce({
      accepted: false,
      messageId: null,
      error: 'temporary failure',
    });

    const saved = await saveShipment(admin, order.id, shipmentInput);
    expect(saved.body.data.email.status).toBe('FAILED');
    const notificationId = saved.body.data.email.notificationId as string;
    expect(notificationId).toBeTruthy();
    expect(mailer.sendMail).toHaveBeenCalledTimes(1);

    // Retry succeeds.
    const retry = await admin.agent
      .post(`/api/v1/admin/notifications/${notificationId}/retry`)
      .set('X-CSRF-Token', admin.csrfToken);
    expect(retry.status).toBe(200);
    expect(retry.body.data.status).toBe('SENT');
    expect(mailer.sendMail).toHaveBeenCalledTimes(2);

    // A second retry must NOT send a duplicate.
    const retryAgain = await admin.agent
      .post(`/api/v1/admin/notifications/${notificationId}/retry`)
      .set('X-CSRF-Token', admin.csrfToken);
    expect(retryAgain.body.data.status).toBe('ALREADY_SENT');
    expect(mailer.sendMail).toHaveBeenCalledTimes(2);

    const { prisma } = await import('../src/lib/prisma.js');
    const notif = await prisma.shipmentNotification.findUnique({
      where: { id: notificationId },
      select: { status: true, attempts: true },
    });
    expect(notif?.status).toBe('SENT');
    expect(notif?.attempts).toBe(2);
  });

  it('deduplicates explicit update emails that reuse an idempotency key', async () => {
    const { order, admin } = await paidOrder();
    await saveShipment(admin, order.id, shipmentInput);
    expect(mailer.sendMail).toHaveBeenCalledTimes(1);

    const key = `idem_${Date.now()}_abcdef`;
    const first = await admin.agent
      .post(`/api/v1/admin/orders/${order.id}/shipment/email`)
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ note: 'Out for delivery', idempotencyKey: key });
    expect(first.status).toBe(200);
    expect(first.body.data.status).toBe('SENT');
    expect(mailer.sendMail).toHaveBeenCalledTimes(2);

    const second = await admin.agent
      .post(`/api/v1/admin/orders/${order.id}/shipment/email`)
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ note: 'Out for delivery', idempotencyKey: key });
    expect(second.status).toBe(200);
    expect(second.body.data.status).toBe('ALREADY_SENT');
    // No duplicate email.
    expect(mailer.sendMail).toHaveBeenCalledTimes(2);

    const { prisma } = await import('../src/lib/prisma.js');
    const updates = await prisma.shipmentNotification.count({
      where: { orderId: order.id, type: 'UPDATE' },
    });
    expect(updates).toBe(1);
  });
});
