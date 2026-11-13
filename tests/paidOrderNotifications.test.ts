// NOTE: './helpers/brevo-order-env.js' MUST stay the first import — it sets
// BREVO_API_KEY (and distinct admin/business recipients) BEFORE
// src/config/env.ts is first evaluated for this file. './helpers/razorpay-env.js'
// then enables the Razorpay test keys. global.fetch is stubbed below, so no real
// email or payment provider is ever contacted.
import './helpers/brevo-order-env.js';
import './helpers/razorpay-env.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Express } from 'express';
import { createAgent, uniqueEmail, type AgentWithCsrf } from './helpers/agent.js';
import {
  buildPaymentSignature,
  buildWebhookSignature,
} from '../src/modules/payments/razorpay.js';

/**
 * Online-paid order notifications through the REAL mailer module (Brevo HTTP
 * transport active) with global.fetch stubbed. Proves that:
 *   - no admin notification is sent before a payment is verified;
 *   - the admin + business emails are sent after a verified online payment,
 *     with online payment wording (never the COD "pay on delivery" copy);
 *   - duplicate webhook deliveries / repeated verification never send a second
 *     copy (idempotency keys `admin-paid:` / `business-paid:`);
 *   - a provider rejection never fails the payment: the order stays PAID and
 *     the outbox records honest, retryable FAILED rows.
 */

const ADMIN = 'draftox0@gmail.com';
const BUSINESS = 'draftoxcustomersupport@gmail.com';
const KEY_SECRET = 'dummy_key_secret_for_tests';
const WEBHOOK_SECRET = 'dummy_webhook_secret_for_tests';
const BREVO_URL = 'https://api.brevo.com/v3/smtp/email';

const SEED_PRICE = 7999;
const SEED_TOTAL = SEED_PRICE + 110;

interface BrevoBody {
  sender: { email: string; name: string };
  to: Array<{ email: string }>;
  subject: string;
  htmlContent: string;
  textContent: string;
}

interface Authed extends AgentWithCsrf {
  email: string;
}

let app: Express;
let fetchMock: ReturnType<typeof vi.fn>;
const thisRun = Math.random().toString(36).slice(2, 8);
let idCounter = 0;
const createdOrderIds: string[] = [];

// Mutable provider state so one router can serve Razorpay + Brevo calls.
let providerOrderId = '';
let paymentId = '';
let brevoAccepts = true;
let brevoCounter = 0;

function uniqueId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}${idCounter}${thisRun}`;
}

function installFetchRouter() {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    const target = String(url);
    if (target === BREVO_URL) {
      if (!brevoAccepts) {
        return Promise.resolve({
          ok: false,
          status: 401,
          json: async () => ({ code: 'unauthorized', message: 'Key not found' }),
        });
      }
      brevoCounter += 1;
      return Promise.resolve({
        ok: true,
        status: 201,
        json: async () => ({ messageId: `mid-paid-${brevoCounter}` }),
      });
    }
    if (target.endsWith('/orders') && init?.method === 'POST') {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ id: providerOrderId }) });
    }
    if (target.includes('/payments/')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          id: paymentId,
          order_id: providerOrderId,
          amount: SEED_TOTAL * 100,
          currency: 'INR',
          status: 'captured',
          method: 'upi',
        }),
      });
    }
    return Promise.resolve({ ok: false, status: 400, json: async () => ({}) });
  });
}

function brevoBodies(): BrevoBody[] {
  return fetchMock.mock.calls
    .filter(([url]) => String(url) === BREVO_URL)
    .map(([, init]) => JSON.parse((init as RequestInit).body as string) as BrevoBody);
}

beforeAll(async () => {
  const mod = await import('../src/app.js');
  app = mod.createApp();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

beforeEach(() => {
  fetchMock.mockReset();
  brevoAccepts = true;
  brevoCounter = 0;
  installFetchRouter();
});

afterAll(async () => {
  vi.unstubAllGlobals();
  const { prisma } = await import('../src/lib/prisma.js');
  await Promise.all(
    createdOrderIds.map((id) => prisma.order.delete({ where: { id } }).catch(() => undefined)),
  );
});

async function registerAgent(prefix = 'paid-order'): Promise<Authed> {
  const { agent, csrfToken } = await createAgent(app);
  const email = uniqueEmail(prefix);
  const res = await agent
    .post('/api/v1/auth/register')
    .set('X-CSRF-Token', csrfToken)
    .send({ name: 'Paid Order Person', email, password: 'testpassword1' });
  expect(res.status).toBe(201);
  return { agent, csrfToken, email };
}

async function fileOrder(auth: Authed): Promise<{ id: string; amount: number }> {
  const { prisma } = await import('../src/lib/prisma.js');
  const product = await prisma.product.findUniqueOrThrow({
    where: { slug: 'draftox-16-channel' },
    select: { id: true },
  });
  const res = await auth.agent
    .post('/api/v1/orders')
    .set('X-CSRF-Token', auth.csrfToken)
    .send({
      items: [{ productId: product.id, qty: 1 }],
      name: 'Paid Order Person',
      email: auth.email,
      phone: '+91 98765 43210',
      address: { line: '1 Main Street', city: 'Mumbai', state: 'Maharashtra', pincode: '400001' },
    });
  expect(res.status).toBe(201);
  const id = res.body.data.order.id as string;
  createdOrderIds.push(id);
  return { id, amount: Number(res.body.data.order.amount) };
}

async function createProviderOrder(
  auth: Authed,
  orderId: string,
  providerId: string,
): Promise<void> {
  providerOrderId = providerId;
  const res = await auth.agent
    .post('/api/v1/payments/razorpay/order')
    .set('X-CSRF-Token', auth.csrfToken)
    .send({ orderId });
  expect(res.status).toBe(201);
  expect(res.body.data.razorpayOrderId).toBe(providerId);
}

function verifyPayload(orderId: string) {
  return {
    orderId,
    razorpayOrderId: providerOrderId,
    razorpayPaymentId: paymentId,
    razorpaySignature: buildPaymentSignature(providerOrderId, paymentId, KEY_SECRET),
  };
}

function postWebhook(
  agent: Authed['agent'],
  body: string,
  opts: { eventId?: string } = {},
) {
  const request = agent
    .post('/api/v1/payments/razorpay/webhook')
    .set('Content-Type', 'application/json')
    .set('x-razorpay-signature', buildWebhookSignature(Buffer.from(body), WEBHOOK_SECRET));
  if (opts.eventId) request.set('x-razorpay-event-id', opts.eventId);
  return request.send(body);
}

describe('online paid-order admin notifications', () => {
  it('sends nothing before verification, then notifies admin + business with paid wording', async () => {
    const auth = await registerAgent();
    const order = await fileOrder(auth);
    await createProviderOrder(auth, order.id, uniqueId('order'));
    paymentId = uniqueId('pay');

    const { prisma } = await import('../src/lib/prisma.js');
    // Before verification: no outbox rows and no email was even attempted.
    expect(await prisma.orderNotification.count({ where: { orderId: order.id } })).toBe(0);
    expect(brevoBodies()).toHaveLength(0);

    const res = await auth.agent
      .post('/api/v1/payments/razorpay/verify')
      .set('X-CSRF-Token', auth.csrfToken)
      .send(verifyPayload(order.id));
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('PAID');

    const bodies = brevoBodies();
    expect(bodies).toHaveLength(2);
    // The customer never receives an internal notification copy.
    expect(new Set(bodies.map((b) => b.to[0]!.email))).toEqual(new Set([ADMIN, BUSINESS]));

    const admin = bodies.find((b) => b.to[0]!.email === ADMIN)!;
    expect(admin.subject).toBe(`New DRAFTOX Order — #${res.body.data.order.orderNumber}`);
    expect(admin.textContent).toContain('PAID (online payment verified)');
    expect(admin.textContent).toContain('UPI (paid online)');
    expect(admin.textContent).toContain('1 Main Street');
    expect(admin.textContent).toContain('was verified online via Razorpay');
    expect(admin.textContent).not.toContain('No online payment was taken');

    const rows = await prisma.orderNotification.findMany({ where: { orderId: order.id } });
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.status).toBe('SENT');
      expect(row.provider).toBe('brevo');
      expect(row.messageId).toMatch(/^mid-paid-/);
    }
    expect(new Set(rows.map((r) => r.idempotencyKey))).toEqual(
      new Set([
        `admin-paid:${order.id}:${ADMIN}`,
        `business-paid:${order.id}:${BUSINESS}`,
      ]),
    );
  });

  it('does not notify when the payment signature is invalid', async () => {
    const auth = await registerAgent('paid-order-badsig');
    const order = await fileOrder(auth);
    await createProviderOrder(auth, order.id, uniqueId('order'));
    paymentId = uniqueId('pay');

    const res = await auth.agent
      .post('/api/v1/payments/razorpay/verify')
      .set('X-CSRF-Token', auth.csrfToken)
      .send({ ...verifyPayload(order.id), razorpaySignature: 'invalid-signature' });
    expect(res.status).toBe(400);
    expect(brevoBodies()).toHaveLength(0);

    const { prisma } = await import('../src/lib/prisma.js');
    expect(await prisma.orderNotification.count({ where: { orderId: order.id } })).toBe(0);
  });

  it('never sends a second copy on duplicate webhooks or repeated verification', async () => {
    const auth = await registerAgent('paid-order-dup');
    const order = await fileOrder(auth);
    await createProviderOrder(auth, order.id, uniqueId('order'));
    paymentId = uniqueId('pay');

    const body = JSON.stringify({
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: paymentId,
            order_id: providerOrderId,
            amount: SEED_TOTAL * 100,
            currency: 'INR',
            status: 'captured',
            method: 'upi',
          },
        },
      },
    });
    const eventId = uniqueId('evt');

    const first = await postWebhook(auth.agent, body, { eventId });
    expect(first.status).toBe(200);
    expect(first.body.data.handled).toBe(true);
    expect(brevoBodies()).toHaveLength(2);

    // Same Razorpay event id: deduplicated before any order/notification work.
    const replay = await postWebhook(auth.agent, body, { eventId });
    expect(replay.status).toBe(200);
    expect(replay.body.data.duplicate).toBe(true);
    expect(brevoBodies()).toHaveLength(2);

    // A DIFFERENT event for the same already-PAID order (order.paid) must also
    // be a notification no-op via the stable idempotency keys.
    const laterBody = JSON.stringify({
      event: 'order.paid',
      payload: {
        order: {
          entity: {
            id: providerOrderId,
            amount: SEED_TOTAL * 100,
            currency: 'INR',
          },
        },
      },
    });
    const later = await postWebhook(auth.agent, laterBody, { eventId: uniqueId('evt') });
    expect(later.status).toBe(200);
    expect(brevoBodies()).toHaveLength(2);

    // And a repeated verify on the already-PAID order sends nothing new either.
    const verify = await auth.agent
      .post('/api/v1/payments/razorpay/verify')
      .set('X-CSRF-Token', auth.csrfToken)
      .send(verifyPayload(order.id));
    expect(verify.status).toBe(200);
    expect(verify.body.data.alreadyPaid).toBe(true);
    expect(brevoBodies()).toHaveLength(2);

    const { prisma } = await import('../src/lib/prisma.js');
    expect(await prisma.orderNotification.count({ where: { orderId: order.id } })).toBe(2);
  });

  it('keeps the order PAID and records retryable FAILED rows when the provider rejects', async () => {
    const auth = await registerAgent('paid-order-reject');
    const order = await fileOrder(auth);
    await createProviderOrder(auth, order.id, uniqueId('order'));
    paymentId = uniqueId('pay');
    brevoAccepts = false;

    const res = await auth.agent
      .post('/api/v1/payments/razorpay/verify')
      .set('X-CSRF-Token', auth.csrfToken)
      .send(verifyPayload(order.id));
    expect(res.status).toBe(200);
    expect(res.body.data.order.status).toBe('PAID');

    const { prisma } = await import('../src/lib/prisma.js');
    const persisted = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(persisted.status).toBe('PAID');

    const rows = await prisma.orderNotification.findMany({ where: { orderId: order.id } });
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.status).toBe('FAILED');
      expect(row.provider).toBe('brevo');
      expect(row.error).toContain('401');
      expect(row.attempts).toBe(1);
    }
  });

  it('boot repair notifies a PAID order whose trigger never ran, exactly once', async () => {
    const auth = await registerAgent('paid-order-repair');
    const order = await fileOrder(auth);
    await createProviderOrder(auth, order.id, uniqueId('order'));
    paymentId = uniqueId('pay');

    // An unpaid order must never be picked up by the repair.
    const unpaid = await fileOrder(auth);

    const verify = await auth.agent
      .post('/api/v1/payments/razorpay/verify')
      .set('X-CSRF-Token', auth.csrfToken)
      .send(verifyPayload(order.id));
    expect(verify.status).toBe(200);
    expect(brevoBodies()).toHaveLength(2);

    const { prisma } = await import('../src/lib/prisma.js');
    // Simulate the regression: the payment succeeded but no notification row
    // was ever written (as with orders paid before the trigger shipped).
    await prisma.orderNotification.deleteMany({ where: { orderId: order.id } });
    expect(await prisma.orderNotification.count({ where: { orderId: order.id } })).toBe(0);

    const { repairMissingPaidOrderNotifications } = await import(
      '../src/modules/orders/paidNotificationRepair.js'
    );
    const repaired = await repairMissingPaidOrderNotifications({
      orderIds: [order.id, unpaid.id],
    });
    // Only the PAID order is repaired.
    expect(repaired.map((r) => r.orderId)).toEqual([order.id]);
    expect(repaired[0]!.results.map((r) => r.status).sort()).toEqual(['SENT', 'SENT']);
    expect(brevoBodies()).toHaveLength(4);

    const rows = await prisma.orderNotification.findMany({ where: { orderId: order.id } });
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.status).toBe('SENT');
      expect(row.idempotencyKey).toMatch(/^(admin|business)-paid:/);
    }

    // A second boot finds nothing to repair and sends no extra copy.
    const again = await repairMissingPaidOrderNotifications({
      orderIds: [order.id, unpaid.id],
    });
    expect(again).toEqual([]);
    expect(brevoBodies()).toHaveLength(4);
    expect(await prisma.orderNotification.count({ where: { orderId: order.id } })).toBe(2);
  });
});
