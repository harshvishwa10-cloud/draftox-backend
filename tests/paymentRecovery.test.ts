// NOTE: './helpers/razorpay-env.js' MUST stay the first import — it enables the
// Razorpay env BEFORE src/config/env.ts is first evaluated for this test file.
import './helpers/razorpay-env.js';
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Express } from 'express';
import { createAgent, uniqueEmail, type AgentWithCsrf } from './helpers/agent.js';
import { getAdminAgent } from './helpers/admin.js';
import { buildWebhookSignature } from '../src/modules/payments/razorpay.js';
import { matchCapturedPayment } from '../src/modules/payments/reconciliation.js';

const WEBHOOK_SECRET = 'dummy_webhook_secret_for_tests';
const SEED_PRICE = 7999;
// Single-unit 16-channel order total: catalog price + flat delivery fee.
const SEED_TOTAL = SEED_PRICE + 110;

// The test DB is shared/persistent across runs and provider ids carry unique
// indexes, so every synthetic id must be fresh.
let idCounter = 0;
function uniqueId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}${idCounter}${Math.random().toString(36).slice(2, 7)}`;
}

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

async function registerAgent(): Promise<AgentWithCsrf & { email: string }> {
  const { agent, csrfToken } = await createAgent(app);
  const email = uniqueEmail('recover');
  const res = await agent
    .post('/api/v1/auth/register')
    .set('X-CSRF-Token', csrfToken)
    .send({ name: 'Recovery Person', email, password: 'testpassword1' });
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

async function fileOrder(
  auth: AgentWithCsrf & { email: string },
  qty = 1,
): Promise<{ id: string }> {
  const res = await auth.agent
    .post('/api/v1/orders')
    .set('X-CSRF-Token', auth.csrfToken)
    .send({
      items: [{ productId: await seed16Id(), qty }],
      name: 'Recovery Person',
      email: auth.email,
      phone: '+91 98765 43210',
      address: { line: '1 Main Street', city: 'Mumbai', state: 'Maharashtra', pincode: '400001' },
    });
  expect(res.status).toBe(201);
  return { id: res.body.data.order.id as string };
}

async function createProviderOrder(
  auth: AgentWithCsrf & { email: string },
  orderId: string,
  providerId: string,
): Promise<void> {
  fetchMock.mockImplementation((url: string) => {
    if (url.endsWith('/orders')) return jsonResponse({ id: providerId });
    return jsonResponse({}, false);
  });
  const res = await auth.agent
    .post('/api/v1/payments/razorpay/order')
    .set('X-CSRF-Token', auth.csrfToken)
    .send({ orderId });
  expect(res.status).toBe(201);
  expect(res.body.data.razorpayOrderId).toBe(providerId);
}

function postWebhook(
  agent: AgentWithCsrf['agent'],
  body: string,
  signature: string,
  eventId?: string,
) {
  const req = agent
    .post('/api/v1/payments/razorpay/webhook')
    .set('Content-Type', 'application/json')
    .set('x-razorpay-signature', signature);
  if (eventId) req.set('x-razorpay-event-id', eventId);
  return req.send(body);
}

/* ------------------------------------------------------------------ */
/* Pure matcher                                                        */
/* ------------------------------------------------------------------ */

describe('matchCapturedPayment', () => {
  it('only matches captured payments with the exact amount and currency', () => {
    const items = [
      { id: 'p1', order_id: 'o1', amount: 100, currency: 'INR', status: 'created' },
      { id: 'p2', order_id: 'o1', amount: 999, currency: 'INR', status: 'captured' },
      { id: 'p3', order_id: 'o1', amount: 100, currency: 'INR', status: 'captured' },
    ];
    expect(matchCapturedPayment(items, 'o1', 100, 'INR')?.id).toBe('p3');
    expect(matchCapturedPayment(items, 'o1', 500, 'INR')).toBeNull();
    expect(
      matchCapturedPayment(
        [{ id: 'x', order_id: 'o1', amount: 100, currency: 'USD', status: 'captured' }],
        'o1',
        100,
        'INR',
      ),
    ).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Durable webhook events + idempotency                                */
/* ------------------------------------------------------------------ */

describe('webhook durability', () => {
  it('records the event durably and dedupes on the x-razorpay-event-id', async () => {
    const { agent } = await createAgent(app);
    const auth = await registerAgent();
    const order = await fileOrder(auth);
    const rzpOrder = uniqueId('order');
    await createProviderOrder(auth, order.id, rzpOrder);

    const eventId = uniqueId('evt');
    const paymentId = uniqueId('pay');
    const body = JSON.stringify({
      event: 'payment.captured',
      payload: {
        payment: {
          entity: { id: paymentId, order_id: rzpOrder, amount: SEED_TOTAL * 100, currency: 'INR', status: 'captured' },
        },
      },
    });
    const sig = buildWebhookSignature(Buffer.from(body), WEBHOOK_SECRET);

    const first = await postWebhook(agent, body, sig, eventId);
    expect(first.status).toBe(200);
    expect(first.body.data.handled).toBe(true);

    const { prisma } = await import('../src/lib/prisma.js');
    const rows = await prisma.webhookEvent.findMany({ where: { eventId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('PROCESSED');
    expect(rows[0].attempts).toBe(1);

    // Re-delivery of the SAME event id: no second row, acknowledged, no error.
    const dup = await postWebhook(agent, body, sig, eventId);
    expect(dup.status).toBe(200);
    expect(dup.body.data.duplicate).toBe(true);
    expect(await prisma.webhookEvent.count({ where: { eventId } })).toBe(1);

    const detail = await auth.agent.get(`/api/v1/orders/${order.id}`);
    expect(detail.body.data.order.status).toBe('PAID');
  });

  it('queues an UNMATCHED_PAYMENT exception for a payment with no local order', async () => {
    const { agent } = await createAgent(app);
    const rzpOrder = uniqueId('order');
    const paymentId = uniqueId('pay');
    const body = JSON.stringify({
      event: 'payment.captured',
      payload: {
        payment: {
          entity: { id: paymentId, order_id: rzpOrder, amount: 500000, currency: 'INR', status: 'captured' },
        },
      },
    });
    const sig = buildWebhookSignature(Buffer.from(body), WEBHOOK_SECRET);

    const res = await postWebhook(agent, body, sig, uniqueId('evt'));
    expect(res.status).toBe(200);
    expect(res.body.data.handled).toBe(false);
    expect(res.body.data.reason).toBe('unmatched_payment');

    const { prisma } = await import('../src/lib/prisma.js');
    const exc = await prisma.paymentException.findFirst({
      where: { kind: 'UNMATCHED_PAYMENT', razorpayOrderId: rzpOrder },
      select: { status: true, razorpayPaymentId: true },
    });
    expect(exc?.status).toBe('OPEN');
    expect(exc?.razorpayPaymentId).toBe(paymentId);
  });

  it('queues a DUPLICATE_PAYMENT exception for a second capture on a paid order', async () => {
    const { agent } = await createAgent(app);
    const auth = await registerAgent();
    const order = await fileOrder(auth);
    const rzpOrder = uniqueId('order');
    await createProviderOrder(auth, order.id, rzpOrder);

    const pay1 = uniqueId('pay');
    const body1 = JSON.stringify({
      event: 'payment.captured',
      payload: { payment: { entity: { id: pay1, order_id: rzpOrder, amount: SEED_TOTAL * 100, currency: 'INR', status: 'captured' } } },
    });
    await postWebhook(agent, body1, buildWebhookSignature(Buffer.from(body1), WEBHOOK_SECRET), uniqueId('evt'));

    const pay2 = uniqueId('pay');
    const body2 = JSON.stringify({
      event: 'payment.captured',
      payload: { payment: { entity: { id: pay2, order_id: rzpOrder, amount: SEED_TOTAL * 100, currency: 'INR', status: 'captured' } } },
    });
    const res = await postWebhook(agent, body2, buildWebhookSignature(Buffer.from(body2), WEBHOOK_SECRET), uniqueId('evt'));
    expect(res.status).toBe(200);
    expect(res.body.data.reason).toBe('duplicate_payment');

    const { prisma } = await import('../src/lib/prisma.js');
    const exc = await prisma.paymentException.findFirst({
      where: { kind: 'DUPLICATE_PAYMENT', razorpayPaymentId: pay2 },
      select: { status: true },
    });
    expect(exc?.status).toBe('OPEN');

    // The order keeps its ORIGINAL verified payment id.
    const row = await prisma.order.findUnique({
      where: { id: order.id },
      select: { status: true, razorpayPaymentId: true },
    });
    expect(row?.status).toBe('PAID');
    expect(row?.razorpayPaymentId).toBe(pay1);
  });
});

/* ------------------------------------------------------------------ */
/* Admin queue + summary + reconciliation                              */
/* ------------------------------------------------------------------ */

describe('admin payment recovery endpoints', () => {
  it('lists and resolves a payment exception (idempotently)', async () => {
    const admin = await getAdminAgent(app);
    const { agent } = await createAgent(app);
    const rzpOrder = uniqueId('order');
    const paymentId = uniqueId('pay');
    const body = JSON.stringify({
      event: 'payment.captured',
      payload: { payment: { entity: { id: paymentId, order_id: rzpOrder, amount: 123400, currency: 'INR', status: 'captured' } } },
    });
    await postWebhook(agent, body, buildWebhookSignature(Buffer.from(body), WEBHOOK_SECRET), uniqueId('evt'));

    const list = await admin.agent.get('/api/v1/admin/payment-exceptions?status=OPEN&kind=UNMATCHED_PAYMENT');
    expect(list.status).toBe(200);
    expect(typeof list.body.data.counts.open).toBe('number');
    const target = (list.body.data.exceptions as Array<{ id: string; razorpayOrderId?: string }>).find(
      (e) => e.razorpayOrderId === rzpOrder,
    );
    expect(target).toBeTruthy();

    const resolved = await admin.agent
      .patch(`/api/v1/admin/payment-exceptions/${target!.id}`)
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ note: 'Refunded manually' });
    expect(resolved.status).toBe(200);
    expect(resolved.body.data.exception.status).toBe('RESOLVED');
    expect(resolved.body.data.exception.resolutionNote).toBe('Refunded manually');
    // Audit trail: who and when the exception was resolved.
    expect(resolved.body.data.exception.resolvedBy).toBeTruthy();
    expect(resolved.body.data.exception.resolvedAt).toBeTruthy();

    // Resolving again is a no-op, not an error.
    const again = await admin.agent
      .patch(`/api/v1/admin/payment-exceptions/${target!.id}`)
      .set('X-CSRF-Token', admin.csrfToken)
      .send({});
    expect(again.status).toBe(200);
    expect(again.body.data.alreadyResolved).toBe(true);
  });

  it('reports the payment audit summary', async () => {
    const admin = await getAdminAgent(app);
    const res = await admin.agent.get('/api/v1/admin/payments/summary');
    expect(res.status).toBe(200);
    expect(typeof res.body.data.openExceptions).toBe('number');
    expect(typeof res.body.data.webhookFailures24h).toBe('number');
    expect(res.body.data.refundSlaHours).toBeGreaterThan(0);
  });

  it('reconciles an order against the provider and marks it PAID', async () => {
    const admin = await getAdminAgent(app);
    const auth = await registerAgent();
    const order = await fileOrder(auth);
    const rzpOrder = uniqueId('order');
    await createProviderOrder(auth, order.id, rzpOrder);
    const paymentId = uniqueId('pay');

    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/orders/') && url.endsWith('/payments')) {
        return jsonResponse({
          entity: 'collection',
          count: 1,
          items: [
            { id: paymentId, order_id: rzpOrder, amount: SEED_TOTAL * 100, currency: 'INR', status: 'captured', method: 'upi' },
          ],
        });
      }
      return jsonResponse({}, false);
    });

    const res = await admin.agent
      .post(`/api/v1/admin/orders/${order.id}/reconcile-payment`)
      .set('X-CSRF-Token', admin.csrfToken)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('reconciled');
    expect(res.body.data.order.status).toBe('PAID');

    const detail = await auth.agent.get(`/api/v1/orders/${order.id}`);
    expect(detail.body.data.order.status).toBe('PAID');
  });

  it('is idempotent: a repeated reconcile reports already_paid without re-charging', async () => {
    const admin = await getAdminAgent(app);
    const auth = await registerAgent();
    const order = await fileOrder(auth);
    const rzpOrder = uniqueId('order');
    await createProviderOrder(auth, order.id, rzpOrder);
    const paymentId = uniqueId('pay');

    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/orders/') && url.endsWith('/payments')) {
        return jsonResponse({
          entity: 'collection',
          count: 1,
          items: [
            { id: paymentId, order_id: rzpOrder, amount: SEED_TOTAL * 100, currency: 'INR', status: 'captured', method: 'upi' },
          ],
        });
      }
      return jsonResponse({}, false);
    });

    const first = await admin.agent
      .post(`/api/v1/admin/orders/${order.id}/reconcile-payment`)
      .set('X-CSRF-Token', admin.csrfToken)
      .send({});
    expect(first.body.data.status).toBe('reconciled');

    const second = await admin.agent
      .post(`/api/v1/admin/orders/${order.id}/reconcile-payment`)
      .set('X-CSRF-Token', admin.csrfToken)
      .send({});
    expect(second.status).toBe(200);
    expect(second.body.data.status).toBe('already_paid');

    const row = await (await import('../src/lib/prisma.js')).prisma.order.findUnique({
      where: { id: order.id },
      select: { status: true, razorpayPaymentId: true },
    });
    expect(row?.status).toBe('PAID');
    expect(row?.razorpayPaymentId).toBe(paymentId);
  });

  it('reports no_provider_order (no provider call) when the order has none', async () => {
    const admin = await getAdminAgent(app);
    const auth = await registerAgent();
    const order = await fileOrder(auth);

    const res = await admin.agent
      .post(`/api/v1/admin/orders/${order.id}/reconcile-payment`)
      .set('X-CSRF-Token', admin.csrfToken)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('no_provider_order');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
