// Razorpay env must be set before src/config/env.ts is first imported so a
// verified paid order can be created. Keep this first.
import './helpers/razorpay-env.js';
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Express } from 'express';
import { createAgent, uniqueEmail, type AgentWithCsrf } from './helpers/agent.js';
import { getAdminAgent, SUPPORT_EMAIL } from './helpers/admin.js';

// Controllable mailer mock so every assertion is about what DRAFTOX attempted
// to send — no real SMTP is ever touched.
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
  mailer.sendMail.mockReset();
  mailer.isReady = true;
  mailer.sendMail.mockResolvedValue({ accepted: true, messageId: 'mid-delivery', error: null });
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
  name: string;
  paymentMethod?: string | null;
  shipment?: { deliveredAt?: string | null } | null;
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

async function registerAgent(prefix = 'deliver', name = 'Test Person'): Promise<Authed> {
  const { agent, csrfToken } = await createAgent(app);
  const email = uniqueEmail(prefix);
  const res = await agent
    .post('/api/v1/auth/register')
    .set('X-CSRF-Token', csrfToken)
    .send({ name, email, password: 'testpassword1' });
  expect(res.status).toBe(201);
  return { agent, csrfToken, email, userId: res.body.data.user.id as string };
}

async function fileOrder(auth: Authed, paymentMethod?: 'cod', name = 'Test Person'): Promise<OrderLike> {
  const res = await auth.agent
    .post('/api/v1/orders')
    .set('X-CSRF-Token', auth.csrfToken)
    .send({
      items: [{ productId: await seed16Id(), qty: 1 }],
      name,
      email: auth.email,
      phone: '+91 98765 43210',
      address: { line: '1 Main Street', city: 'Mumbai', state: 'Maharashtra', pincode: '400001' },
      ...(paymentMethod ? { paymentMethod } : {}),
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

async function paidOrder(name = 'Test Person') {
  const customer = await registerAgent('deliver', name);
  const order = await fileOrder(customer, undefined, name);
  await payOrder(customer, order.id);
  const admin = await getAdminAgent(app);
  return { customer, order, admin };
}

function markDelivered(admin: Authed, orderId: string, input: Record<string, unknown> = {}) {
  return admin.agent
    .post(`/api/v1/admin/orders/${orderId}/deliver`)
    .set('X-CSRF-Token', admin.csrfToken)
    .send(input);
}

async function outbox(orderId: string, type: 'DELIVERY_CONFIRMED' | 'INITIAL' | 'UPDATE') {
  const { prisma } = await import('../src/lib/prisma.js');
  return prisma.shipmentNotification.findMany({
    where: { orderId, type },
    select: { id: true, status: true, attempts: true, messageId: true, error: true },
  });
}

/* ------------------------------------------------------------------ */
/* Mark as delivered + confirmation email                              */
/* ------------------------------------------------------------------ */

describe('mark order as delivered', () => {
  it('records the delivery, refreshes the customer view and sends one confirmation email', async () => {
    const { customer, order, admin } = await paidOrder();

    const res = await markDelivered(admin, order.id, { note: 'Handed to customer' });
    expect(res.status).toBe(200);
    expect(res.body.data.fulfillmentStatus).toBe('DELIVERED');
    expect(res.body.data.alreadyDelivered).toBe(false);
    expect(res.body.data.email.status).toBe('SENT');
    expect(mailer.sendMail).toHaveBeenCalledTimes(1);

    // The email is a real confirmation addressed to the customer.
    const call = mailer.sendMail.mock.calls[0][0] as {
      to: string;
      subject: string;
      html: string;
      text: string;
    };
    expect(call.to).toBe(order.email);
    expect(call.subject).toMatch(/has been delivered/i);
    expect(call.subject).toContain(order.orderNumber!);
    expect(call.html).toContain(order.orderNumber!);
    expect(call.html).toContain(SUPPORT_EMAIL);
    expect(call.html).toContain('RESIDE 16-Channel');
    expect(call.text).toContain(order.orderNumber!);

    // The delivery timestamp is persisted server-side and visible to the
    // customer on a fresh load/refresh.
    const view = await customer.agent.get(`/api/v1/orders/${order.id}`);
    expect(view.status).toBe(200);
    expect(view.body.data.order.fulfillmentStatus).toBe('DELIVERED');
    expect(view.body.data.order.shipment.deliveredAt).toBeTruthy();
    expect(res.body.data.deliveredAt).toBe(view.body.data.order.shipment.deliveredAt);

    // COD-independent payment status stays PAID on an online payment.
    expect(view.body.data.order.status).toBe('PAID');

    const rows = await outbox(order.id, 'DELIVERY_CONFIRMED');
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('SENT');

    const { prisma } = await import('../src/lib/prisma.js');
    const event = await prisma.orderEvent.findFirst({
      where: { orderId: order.id, type: 'DELIVERY_CONFIRMED' },
      select: { actorName: true, message: true },
    });
    expect(event).not.toBeNull();
    expect(event!.message).toContain('Handed to customer');
  });

  it('is idempotent: a repeated click never sends a duplicate email', async () => {
    const { order, admin } = await paidOrder();
    const first = await markDelivered(admin, order.id);
    expect(first.status).toBe(200);
    expect(mailer.sendMail).toHaveBeenCalledTimes(1);

    const second = await markDelivered(admin, order.id);
    expect(second.status).toBe(200);
    expect(second.body.data.alreadyDelivered).toBe(true);
    expect(second.body.data.email.status).toBe('SKIPPED');
    // A repeated click reports the persisted timestamp — never a fresh "now".
    expect(second.body.data.deliveredAt).toBe(first.body.data.deliveredAt);
    expect(mailer.sendMail).toHaveBeenCalledTimes(1);

    expect(await outbox(order.id, 'DELIVERY_CONFIRMED')).toHaveLength(1);
  });

  it('handles two concurrent delivery clicks with a single email and event', async () => {
    const { order, admin } = await paidOrder();

    const [a, b] = await Promise.all([
      markDelivered(admin, order.id),
      markDelivered(admin, order.id),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // Exactly one caller did the real transition; the other is idempotent.
    const already = [a.body.data.alreadyDelivered, b.body.data.alreadyDelivered].sort();
    expect(already).toEqual([false, true]);
    expect(mailer.sendMail).toHaveBeenCalledTimes(1);
    expect(await outbox(order.id, 'DELIVERY_CONFIRMED')).toHaveLength(1);
  });

  it('keeps the delivery when the confirmation email fails, and can retry it', async () => {
    const { customer, order, admin } = await paidOrder();
    mailer.sendMail.mockResolvedValueOnce({
      accepted: false,
      messageId: null,
      error: 'smtp 550 mailbox unavailable',
    });

    const res = await markDelivered(admin, order.id);
    expect(res.status).toBe(200);
    expect(res.body.data.email.status).toBe('FAILED');

    // Delivery is persistent even though the email failed.
    const view = await customer.agent.get(`/api/v1/orders/${order.id}`);
    expect(view.body.data.order.fulfillmentStatus).toBe('DELIVERED');
    expect(view.body.data.order.shipment.deliveredAt).toBeTruthy();

    const rows = await outbox(order.id, 'DELIVERY_CONFIRMED');
    expect(rows[0].status).toBe('FAILED');

    const retry = await admin.agent
      .post(`/api/v1/admin/notifications/${rows[0].id}/retry`)
      .set('X-CSRF-Token', admin.csrfToken);
    expect(retry.status).toBe(200);
    expect(retry.body.data.status).toBe('SENT');
    expect(mailer.sendMail).toHaveBeenCalledTimes(2);
  });

  it('never marks a COD order as paid when it is delivered', async () => {
    const customer = await registerAgent('deliver-cod');
    const order = await fileOrder(customer, 'cod');
    expect(order.status).toBe('CONFIRMED');
    const admin = await getAdminAgent(app);

    const res = await markDelivered(admin, order.id);
    expect(res.status).toBe(200);
    expect(res.body.data.fulfillmentStatus).toBe('DELIVERED');

    const view = await customer.agent.get(`/api/v1/orders/${order.id}`);
    expect(view.body.data.order.fulfillmentStatus).toBe('DELIVERED');
    expect(view.body.data.order.status).toBe('CONFIRMED');
    expect(view.body.data.order.razorpayPaymentId).toBeFalsy();
    // Creating a COD order also sends the order-confirmation mails, so assert
    // on the delivery confirmation specifically rather than the total count.
    const deliveryMails = mailer.sendMail.mock.calls.filter((call) =>
      /has been delivered/i.test((call[0] as { subject: string }).subject),
    );
    expect(deliveryMails).toHaveLength(1);
  });

  it('rejects a cancelled order', async () => {
    const { order, admin } = await paidOrder();
    const { prisma } = await import('../src/lib/prisma.js');
    await prisma.order.update({
      where: { id: order.id },
      data: { fulfillmentStatus: 'CANCELLED' },
    });

    const res = await markDelivered(admin, order.id);
    expect(res.status).toBe(409);
    expect(mailer.sendMail).not.toHaveBeenCalled();

    const after = await prisma.order.findUnique({
      where: { id: order.id },
      select: { fulfillmentStatus: true },
    });
    expect(after?.fulfillmentStatus).toBe('CANCELLED');
  });

  it('rejects an order whose parcel has been returned', async () => {
    const { order, admin } = await paidOrder();
    const { prisma } = await import('../src/lib/prisma.js');
    await prisma.returnRequest.create({
      data: {
        orderId: order.id,
        reason: 'DEFECTIVE',
        explanation: 'Unit arrived faulty and was returned to DRAFTOX.',
        status: 'ITEM_RECEIVED',
        photos: [],
      },
    });

    const res = await markDelivered(admin, order.id);
    expect(res.status).toBe(409);
    expect(mailer.sendMail).not.toHaveBeenCalled();

    const after = await prisma.order.findUnique({
      where: { id: order.id },
      select: { fulfillmentStatus: true },
    });
    expect(after?.fulfillmentStatus).not.toBe('DELIVERED');
  });

  it('rejects an unpaid online order', async () => {
    const customer = await registerAgent('deliver-unpaid');
    const order = await fileOrder(customer);
    expect(order.status).toBe('REQUESTED');
    const admin = await getAdminAgent(app);

    const res = await markDelivered(admin, order.id);
    expect(res.status).toBe(409);
    expect(mailer.sendMail).not.toHaveBeenCalled();
  });

  it('is protected server-side: an ordinary customer gets 403', async () => {
    const customer = await registerAgent('deliver-notadmin');
    const order = await fileOrder(customer);

    const res = await customer.agent
      .post(`/api/v1/admin/orders/${order.id}/deliver`)
      .set('X-CSRF-Token', customer.csrfToken)
      .send({});
    expect(res.status).toBe(403);
    expect(mailer.sendMail).not.toHaveBeenCalled();
  });

  it('escapes dynamic content in the confirmation email HTML', async () => {
    const hostileName = '<script>alert(1)</script>';
    const { order, admin } = await paidOrder(hostileName);
    const res = await markDelivered(admin, order.id);
    expect(res.status).toBe(200);

    const html = (mailer.sendMail.mock.calls[0][0] as { html: string }).html;
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

/* ------------------------------------------------------------------ */
/* Controlled resend                                                   */
/* ------------------------------------------------------------------ */

describe('delivery confirmation resend', () => {
  it('refuses to resend before the order is delivered', async () => {
    const { order, admin } = await paidOrder();
    const res = await admin.agent
      .post(`/api/v1/admin/orders/${order.id}/delivery-confirmation/resend`)
      .set('X-CSRF-Token', admin.csrfToken)
      .send({});
    expect(res.status).toBe(409);
    expect(mailer.sendMail).not.toHaveBeenCalled();
  });

  it('sends a fresh confirmation on an explicit resend, without duplicating the automatic one', async () => {
    const { order, admin } = await paidOrder();
    await markDelivered(admin, order.id);
    expect(mailer.sendMail).toHaveBeenCalledTimes(1);

    const resend = await admin.agent
      .post(`/api/v1/admin/orders/${order.id}/delivery-confirmation/resend`)
      .set('X-CSRF-Token', admin.csrfToken)
      .send({});
    expect(resend.status).toBe(200);
    expect(resend.body.data.status).toBe('SENT');
    expect(mailer.sendMail).toHaveBeenCalledTimes(2);

    // The automatic key is unaffected, so clicking "already delivered" again
    // still cannot add a third copy.
    await markDelivered(admin, order.id);
    expect(mailer.sendMail).toHaveBeenCalledTimes(2);
  });
});
