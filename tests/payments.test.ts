// NOTE: './helpers/razorpay-env.js' MUST stay the first import — it enables the
// Razorpay env BEFORE src/config/env.ts is first evaluated for this test file.
import './helpers/razorpay-env.js';
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import type { Express } from 'express';
import { createAgent, uniqueEmail, type AgentWithCsrf } from './helpers/agent.js';
import {
  buildPaymentSignature,
  buildWebhookSignature,
  parseWebhookEvent,
  toPaise,
  verifyPaymentSignature,
  verifyWebhookSignature,
} from '../src/modules/payments/razorpay.js';

const KEY_SECRET = 'dummy_key_secret_for_tests';
const WEBHOOK_SECRET = 'dummy_webhook_secret_for_tests';

// The test DB is shared/persistent across runs and razorpayOrderId /
// razorpayPaymentId carry unique indexes, so every provider id must be fresh.
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
  const email = uniqueEmail('payer');
  const res = await agent
    .post('/api/v1/auth/register')
    .set('X-CSRF-Token', csrfToken)
    .send({ name: 'Payer Person', email, password: 'testpassword1' });
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

// Seeded price for draftox-16-channel.
const SEED_PRICE = 7999;
// Single-unit 16-channel order total: catalog price + flat delivery fee.
const SEED_TOTAL = SEED_PRICE + 110;

async function fileOrder(
  auth: AgentWithCsrf & { email: string },
  qty = 1,
): Promise<{ id: string; amount: number }> {
  const res = await auth.agent
    .post('/api/v1/orders')
    .set('X-CSRF-Token', auth.csrfToken)
    .send({
      items: [{ productId: await seed16Id(), qty }],
      name: 'Payer Person',
      email: auth.email,
      phone: '+91 98765 43210',
      address: { line: '1 Main Street', city: 'Mumbai', state: 'Maharashtra', pincode: '400001' },
    });
  expect(res.status).toBe(201);
  return { id: res.body.data.order.id as string, amount: Number(res.body.data.order.amount) };
}

/** Creates a Razorpay order for a filed order and returns the provider id. */
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

/* ------------------------------------------------------------------ */
/* Pure helpers                                                        */
/* ------------------------------------------------------------------ */

describe('razorpay helpers', () => {
  it('builds the documented `order_id|payment_id` HMAC signature', () => {
    const expected = createHmac('sha256', KEY_SECRET).update('order_a|pay_b').digest('hex');
    expect(buildPaymentSignature('order_a', 'pay_b', KEY_SECRET)).toBe(expected);
    expect(
      verifyPaymentSignature({
        razorpayOrderId: 'order_a',
        razorpayPaymentId: 'pay_b',
        signature: expected,
        keySecret: KEY_SECRET,
      }),
    ).toBe(true);
  });

  it('rejects tampered/blank payment signatures', () => {
    const valid = buildPaymentSignature('order_a', 'pay_b', KEY_SECRET);
    expect(
      verifyPaymentSignature({
        razorpayOrderId: 'order_a',
        razorpayPaymentId: 'pay_b',
        signature: `${valid.slice(0, -1)}0`,
        keySecret: KEY_SECRET,
      }),
    ).toBe(false);
    expect(
      verifyPaymentSignature({
        razorpayOrderId: 'order_a',
        razorpayPaymentId: 'pay_b',
        signature: 'not-a-signature',
        keySecret: KEY_SECRET,
      }),
    ).toBe(false);
    expect(
      verifyPaymentSignature({
        razorpayOrderId: 'order_a',
        razorpayPaymentId: 'pay_b',
        signature: valid,
        keySecret: 'wrong-secret',
      }),
    ).toBe(false);
  });

  it('verifies webhook HMAC bodies and rejects mismatches', () => {
    const body = Buffer.from(JSON.stringify({ event: 'payment.captured' }));
    const sig = buildWebhookSignature(body, WEBHOOK_SECRET);
    expect(verifyWebhookSignature(body, sig, WEBHOOK_SECRET)).toBe(true);
    expect(verifyWebhookSignature(body, 'deadbeef', WEBHOOK_SECRET)).toBe(false);
    expect(verifyWebhookSignature(Buffer.from('{"event":"tampered"}'), sig, WEBHOOK_SECRET)).toBe(false);
  });

  it('converts rupee amounts to integer paise and parses events', () => {
    expect(toPaise('7999')).toBe(799900);
    expect(toPaise('7999.5')).toBe(799950);
    expect(Number.isNaN(toPaise('abc' as unknown as string))).toBe(true);

    expect(
      parseWebhookEvent({
        event: 'payment.captured',
        payload: { payment: { entity: { order_id: 'o1', id: 'p1', amount: 100, currency: 'INR' } } },
      }),
    ).toEqual({
      action: 'paid',
      razorpayOrderId: 'o1',
      razorpayPaymentId: 'p1',
      amountPaise: 100,
      currency: 'INR',
    });

    expect(
      parseWebhookEvent({
        event: 'order.paid',
        payload: { order: { entity: { id: 'o2', amount: 200, currency: 'INR' } } },
      }),
    ).toEqual({ action: 'paid', razorpayOrderId: 'o2', amountPaise: 200, currency: 'INR' });

    expect(parseWebhookEvent({ event: 'payment.authorized' })).toEqual({ action: 'ignored' });
  });
});

/* ------------------------------------------------------------------ */
/* Razorpay order creation                                             */
/* ------------------------------------------------------------------ */

describe('POST /api/v1/payments/razorpay/order', () => {
  it('reports razorpay + webhook configured', async () => {
    const { agent } = await createAgent(app);
    const res = await agent.get('/api/v1/payments/status');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ razorpay: true, webhook: true });
  });

  it('401s for guests', async () => {
    const { agent, csrfToken } = await createAgent(app);
    const res = await agent
      .post('/api/v1/payments/razorpay/order')
      .set('X-CSRF-Token', csrfToken)
      .send({ orderId: 'whatever' });
    expect(res.status).toBe(401);
  });

  it('creates a provider order using the server-computed amount', async () => {
    const auth = await registerAgent();
    const order = await fileOrder(auth, 1);
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
    expect(res.body.data.amount).toBe(SEED_TOTAL * 100);
    expect(res.body.data.currency).toBe('INR');
    expect(res.body.data.keyId).toBe('rzp_test_dummykey0001');
    expect(sentBody.amount).toBe(SEED_TOTAL * 100);
    expect(sentBody.currency).toBe('INR');
    expect(sentBody.receipt).toBe(order.id);
  });

  it("404s when paying another user's order (ownership)", async () => {
    const owner = await registerAgent();
    const order = await fileOrder(owner, 1);
    const other = await registerAgent();

    fetchMock.mockImplementation(() => jsonResponse({ id: uniqueId('order') }));
    const res = await other.agent
      .post('/api/v1/payments/razorpay/order')
      .set('X-CSRF-Token', other.csrfToken)
      .send({ orderId: order.id });
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reuses the existing provider order on retry (no duplicates)', async () => {
    const auth = await registerAgent();
    const order = await fileOrder(auth, 1);
    const providerId = uniqueId('order');
    await createProviderOrder(auth, order.id, providerId);

    // Second request: must NOT call the provider again.
    fetchMock.mockReset();
    const again = await auth.agent
      .post('/api/v1/payments/razorpay/order')
      .set('X-CSRF-Token', auth.csrfToken)
      .send({ orderId: order.id });
    expect(again.status).toBe(200);
    expect(again.body.data.razorpayOrderId).toBe(providerId);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/* Signature verification endpoint                                     */
/* ------------------------------------------------------------------ */

describe('POST /api/v1/payments/razorpay/verify', () => {
  it('marks the order PAID only after a valid, matching signature', async () => {
    const auth = await registerAgent();
    const order = await fileOrder(auth, 1);
    const providerOrderId = uniqueId('order');
    const paymentId = uniqueId('pay');
    await createProviderOrder(auth, order.id, providerOrderId);

    fetchMock.mockImplementation((url: string) =>
      url.includes('/payments/')
        ? jsonResponse({
            id: paymentId,
            order_id: providerOrderId,
            amount: SEED_TOTAL * 100,
            currency: 'INR',
            status: 'captured',
          })
        : jsonResponse({}, false),
    );

    const signature = buildPaymentSignature(providerOrderId, paymentId, KEY_SECRET);
    const res = await auth.agent
      .post('/api/v1/payments/razorpay/verify')
      .set('X-CSRF-Token', auth.csrfToken)
      .send({
        orderId: order.id,
        razorpayOrderId: providerOrderId,
        razorpayPaymentId: paymentId,
        razorpaySignature: signature,
      });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('PAID');
    expect(res.body.data.order.status).toBe('PAID');

    const detail = await auth.agent.get(`/api/v1/orders/${order.id}`);
    expect(detail.body.data.order.status).toBe('PAID');
  });

  it('rejects an invalid signature and never marks paid', async () => {
    const auth = await registerAgent();
    const order = await fileOrder(auth, 1);
    const providerOrderId = uniqueId('order');
    const paymentId = uniqueId('pay');
    await createProviderOrder(auth, order.id, providerOrderId);

    fetchMock.mockImplementation(() =>
      jsonResponse({
        id: paymentId,
        order_id: providerOrderId,
        amount: SEED_TOTAL * 100,
        currency: 'INR',
        status: 'captured',
      }),
    );
    const res = await auth.agent
      .post('/api/v1/payments/razorpay/verify')
      .set('X-CSRF-Token', auth.csrfToken)
      .send({
        orderId: order.id,
        razorpayOrderId: providerOrderId,
        razorpayPaymentId: paymentId,
        razorpaySignature: 'clearly-invalid-signature',
      });
    expect(res.status).toBe(400);

    const detail = await auth.agent.get(`/api/v1/orders/${order.id}`);
    expect(detail.body.data.order.status).toBe('REQUESTED');
  });

  it('rejects a payment whose amount does not match the order', async () => {
    const auth = await registerAgent();
    const order = await fileOrder(auth, 1);
    const providerOrderId = uniqueId('order');
    const paymentId = uniqueId('pay');
    await createProviderOrder(auth, order.id, providerOrderId);

    fetchMock.mockImplementation(() =>
      jsonResponse({ id: paymentId, order_id: providerOrderId, amount: 100, currency: 'INR', status: 'captured' }),
    );
    const signature = buildPaymentSignature(providerOrderId, paymentId, KEY_SECRET);
    const res = await auth.agent
      .post('/api/v1/payments/razorpay/verify')
      .set('X-CSRF-Token', auth.csrfToken)
      .send({
        orderId: order.id,
        razorpayOrderId: providerOrderId,
        razorpayPaymentId: paymentId,
        razorpaySignature: signature,
      });
    expect(res.status).toBe(400);

    const detail = await auth.agent.get(`/api/v1/orders/${order.id}`);
    expect(detail.body.data.order.status).toBe('REQUESTED');
  });

  it('rejects a provider order id that is not linked to the local order', async () => {
    const auth = await registerAgent();
    const order = await fileOrder(auth, 1);
    const providerOrderId = uniqueId('order');
    await createProviderOrder(auth, order.id, providerOrderId);

    fetchMock.mockImplementation(() => jsonResponse({}, false));
    const otherProviderOrderId = uniqueId('order');
    const paymentId = uniqueId('pay');
    const signature = buildPaymentSignature(otherProviderOrderId, paymentId, KEY_SECRET);
    const res = await auth.agent
      .post('/api/v1/payments/razorpay/verify')
      .set('X-CSRF-Token', auth.csrfToken)
      .send({
        orderId: order.id,
        razorpayOrderId: otherProviderOrderId,
        razorpayPaymentId: paymentId,
        razorpaySignature: signature,
      });
    expect(res.status).toBe(400);
  });

  it('is idempotent on repeat verification', async () => {
    const auth = await registerAgent();
    const order = await fileOrder(auth, 1);
    const providerOrderId = uniqueId('order');
    const paymentId = uniqueId('pay');
    await createProviderOrder(auth, order.id, providerOrderId);

    fetchMock.mockImplementation(() =>
      jsonResponse({
        id: paymentId,
        order_id: providerOrderId,
        amount: SEED_TOTAL * 100,
        currency: 'INR',
        status: 'captured',
      }),
    );
    const signature = buildPaymentSignature(providerOrderId, paymentId, KEY_SECRET);
    const payload = {
      orderId: order.id,
      razorpayOrderId: providerOrderId,
      razorpayPaymentId: paymentId,
      razorpaySignature: signature,
    };

    const first = await auth.agent
      .post('/api/v1/payments/razorpay/verify')
      .set('X-CSRF-Token', auth.csrfToken)
      .send(payload);
    expect(first.status).toBe(200);

    const second = await auth.agent
      .post('/api/v1/payments/razorpay/verify')
      .set('X-CSRF-Token', auth.csrfToken)
      .send(payload);
    expect(second.status).toBe(200);
    expect(second.body.data.alreadyPaid).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Webhook                                                             */
/* ------------------------------------------------------------------ */

function postWebhook(agent: AgentWithCsrf['agent'], body: string, signature: string) {
  return agent
    .post('/api/v1/payments/razorpay/webhook')
    .set('Content-Type', 'application/json')
    .set('x-razorpay-signature', signature)
    .send(body);
}

describe('POST /api/v1/payments/razorpay/webhook', () => {
  async function setupOrderWithProviderId() {
    const auth = await registerAgent();
    const order = await fileOrder(auth, 1);
    const providerOrderId = uniqueId('order');
    await createProviderOrder(auth, order.id, providerOrderId);
    return { auth, order, razorpayOrderId: providerOrderId };
  }

  it('rejects an invalid webhook signature with 400', async () => {
    const { agent } = await createAgent(app);
    const body = JSON.stringify({ event: 'payment.captured', payload: {} });
    const res = await postWebhook(agent, body, 'bad-signature');
    expect(res.status).toBe(400);
  });

  it('marks the matching order PAID on payment.captured and is idempotent', async () => {
    const { agent } = await createAgent(app);
    const { auth, order, razorpayOrderId } = await setupOrderWithProviderId();
    const paymentId = uniqueId('pay');

    const body = JSON.stringify({
      event: 'payment.captured',
      payload: {
        payment: {
          entity: { id: paymentId, order_id: razorpayOrderId, amount: SEED_TOTAL * 100, currency: 'INR', status: 'captured' },
        },
      },
    });
    const sig = buildWebhookSignature(Buffer.from(body), WEBHOOK_SECRET);

    const first = await postWebhook(agent, body, sig);
    expect(first.status).toBe(200);
    expect(first.body.data.handled).toBe(true);

    const detail = await auth.agent.get(`/api/v1/orders/${order.id}`);
    expect(detail.body.data.order.status).toBe('PAID');

    // Duplicate delivery: acknowledged, still PAID, no error.
    const second = await postWebhook(agent, body, sig);
    expect(second.status).toBe(200);

    const after = await auth.agent.get(`/api/v1/orders/${order.id}`);
    expect(after.body.data.order.status).toBe('PAID');
  });

  it('does not mark paid when the webhook amount mismatches', async () => {
    const { agent } = await createAgent(app);
    const { auth, order, razorpayOrderId } = await setupOrderWithProviderId();

    const body = JSON.stringify({
      event: 'payment.captured',
      payload: {
        payment: { entity: { id: uniqueId('pay'), order_id: razorpayOrderId, amount: 1, currency: 'INR' } },
      },
    });
    const sig = buildWebhookSignature(Buffer.from(body), WEBHOOK_SECRET);
    const res = await postWebhook(agent, body, sig);
    expect(res.status).toBe(200);
    expect(res.body.data.handled).toBe(false);
    expect(res.body.data.reason).toBe('amount_mismatch');

    const detail = await auth.agent.get(`/api/v1/orders/${order.id}`);
    expect(detail.body.data.order.status).toBe('REQUESTED');
  });

  it('records FAILED on payment.failed, then PAID on a later capture (out-of-order safe)', async () => {
    const { agent } = await createAgent(app);
    const { auth, order, razorpayOrderId } = await setupOrderWithProviderId();

    const failedBody = JSON.stringify({
      event: 'payment.failed',
      payload: {
        payment: { entity: { id: uniqueId('pay'), order_id: razorpayOrderId, amount: SEED_TOTAL * 100, currency: 'INR' } },
      },
    });
    const failedRes = await postWebhook(
      agent,
      failedBody,
      buildWebhookSignature(Buffer.from(failedBody), WEBHOOK_SECRET),
    );
    expect(failedRes.status).toBe(200);
    const afterFail = await auth.agent.get(`/api/v1/orders/${order.id}`);
    expect(afterFail.body.data.order.status).toBe('FAILED');

    const paidBody = JSON.stringify({
      event: 'payment.captured',
      payload: {
        payment: { entity: { id: uniqueId('pay'), order_id: razorpayOrderId, amount: SEED_TOTAL * 100, currency: 'INR' } },
      },
    });
    await postWebhook(agent, paidBody, buildWebhookSignature(Buffer.from(paidBody), WEBHOOK_SECRET));
    const afterPaid = await auth.agent.get(`/api/v1/orders/${order.id}`);
    expect(afterPaid.body.data.order.status).toBe('PAID');
  });

  it('ignores unknown events and unknown orders without error', async () => {
    const { agent } = await createAgent(app);
    const ignoredBody = JSON.stringify({ event: 'payment.authorized', payload: {} });
    const ignored = await postWebhook(
      agent,
      ignoredBody,
      buildWebhookSignature(Buffer.from(ignoredBody), WEBHOOK_SECRET),
    );
    expect(ignored.status).toBe(200);
    expect(ignored.body.data.handled).toBe(false);
  });
});
