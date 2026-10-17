// Razorpay env must be set before src/config/env.ts is first imported so the
// verified paid-cancellation refund path below is available.
import './helpers/razorpay-env.js';
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Express } from 'express';
import { createAgent, uniqueEmail, type AgentWithCsrf } from './helpers/agent.js';
import { canCustomerCancel } from '../src/modules/orders/cancellation.js';

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
});

afterAll(async () => {
  vi.unstubAllGlobals();
  const { prisma } = await import('../src/lib/prisma.js');
  await Promise.all(ordersToCleanup.map((id) => prisma.order.delete({ where: { id } }).catch(() => undefined)));
});

function jsonResponse(payload: unknown, ok = true) {
  return Promise.resolve({ ok, status: ok ? 200 : 400, json: async () => payload });
}

interface Authed extends AgentWithCsrf {
  email: string;
}

async function registerAgent(prefix = 'cancel'): Promise<Authed> {
  const { agent, csrfToken } = await createAgent(app);
  const email = uniqueEmail(prefix);
  const res = await agent
    .post('/api/v1/auth/register')
    .set('X-CSRF-Token', csrfToken)
    .send({ name: 'Cancel Person', email, password: 'testpassword1' });
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
  fulfillmentStatus?: string;
}

async function fileOrder(auth: Authed): Promise<OrderLike> {
  const res = await auth.agent
    .post('/api/v1/orders')
    .set('X-CSRF-Token', auth.csrfToken)
    .send({
      items: [{ productId: await seed16Id(), qty: 1 }],
      name: 'Cancel Person',
      email: auth.email,
      phone: '+91 98765 43210',
      address: { line: '1 Main Street', city: 'Mumbai', state: 'Maharashtra', pincode: '400001' },
    });
  expect(res.status).toBe(201);
  const order = res.body.data.order as OrderLike;
  ordersToCleanup.push(order.id);
  return order;
}

let idCounter = 0;
function uniqueId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}${idCounter}${Math.random().toString(36).slice(2, 7)}`;
}

async function setFulfillment(orderId: string, fulfillmentStatus: string): Promise<void> {
  const { prisma } = await import('../src/lib/prisma.js');
  await prisma.order.update({ where: { id: orderId }, data: { fulfillmentStatus: fulfillmentStatus as never } });
}

function cancelById(auth: Authed, orderId: string | number) {
  return auth.agent
    .post(`/api/v1/orders/${orderId}/cancel`)
    .set('X-CSRF-Token', auth.csrfToken)
    .send({ reason: 'CHANGED_MIND' });
}

/* ------------------------------------------------------------------ */
/* Pure eligibility matrix                                             */
/* ------------------------------------------------------------------ */

describe('canCustomerCancel eligibility matrix', () => {
  it('allows unpaid orders not yet with a courier', () => {
    for (const fs of ['AWAITING_PAYMENT', 'PROCESSING', 'READY_TO_SHIP']) {
      const r = canCustomerCancel({ status: 'PAID', fulfillmentStatus: fs });
      expect(r).toEqual({ allowed: true, reason: null });
    }
  });

  it('reports already-cancelled orders (by status or fulfilment)', () => {
    expect(canCustomerCancel({ status: 'CANCELLED', fulfillmentStatus: 'AWAITING_PAYMENT' })).toEqual({
      allowed: false,
      reason: 'ALREADY_CANCELLED',
    });
    expect(canCustomerCancel({ status: 'PAID', fulfillmentStatus: 'CANCELLED' })).toEqual({
      allowed: false,
      reason: 'ALREADY_CANCELLED',
    });
  });

  it('blocks delivered orders', () => {
    expect(canCustomerCancel({ status: 'PAID', fulfillmentStatus: 'DELIVERED' })).toEqual({
      allowed: false,
      reason: 'DELIVERED',
    });
  });

  it('blocks orders already with the courier', () => {
    for (const fs of ['SHIPPED', 'OUT_FOR_DELIVERY']) {
      const r = canCustomerCancel({ status: 'PAID', fulfillmentStatus: fs });
      expect(r).toEqual({ allowed: false, reason: 'WITH_COURIER' });
    }
  });
});

/* ------------------------------------------------------------------ */
/* Endpoint behaviour                                                  */
/* ------------------------------------------------------------------ */

describe('POST /api/v1/orders/:id/cancel', () => {
  it('401s for guests', async () => {
    const { agent, csrfToken } = await createAgent(app);
    expect(
      (await agent.post('/api/v1/orders/whatever/cancel').set('X-CSRF-Token', csrfToken).send({}))
        .status,
    ).toBe(401);
  });

  it("never reveals another customer's order (404, not 403)", async () => {
    const owner = await registerAgent();
    const order = await fileOrder(owner);
    const other = await registerAgent('other');
    expect((await cancelById(other, order.id)).status).toBe(404);
    expect(
      (await other.agent
        .post(`/api/v1/orders/by-number/${order.orderNumber}/cancel`)
        .set('X-CSRF-Token', other.csrfToken)
        .send({})).status,
    ).toBe(404);
  });

  it('404s on malformed or unknown numbers', async () => {
    const auth = await registerAgent();
    for (const bad of ['1234', '123456', '99999']) {
      const res = await auth.agent
        .post(`/api/v1/orders/by-number/${bad}/cancel`)
        .set('X-CSRF-Token', auth.csrfToken)
        .send({});
      expect(res.status).toBe(404);
    }
  });

  it('requires a typed reason for a fresh cancellation (400)', async () => {
    const auth = await registerAgent();
    const order = await fileOrder(auth);
    const res = await auth.agent
      .post(`/api/v1/orders/${order.id}/cancel`)
      .set('X-CSRF-Token', auth.csrfToken)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('reason');
    // A reason outside the enum is rejected by validation, before anything is cancelled.
    const bad = await auth.agent
      .post(`/api/v1/orders/${order.id}/cancel`)
      .set('X-CSRF-Token', auth.csrfToken)
      .send({ reason: 'Just felt like it' });
    expect(bad.status).toBe(422);
    const { prisma } = await import('../src/lib/prisma.js');
    const orderAfter = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(orderAfter.status).toBe('REQUESTED');
  });

  it('cancels an unpaid order, records ONE event, and is idempotent on retry', async () => {
    const auth = await registerAgent();
    const order = await fileOrder(auth);

    const first = await cancelById(auth, order.id);
    expect(first.status).toBe(200);
    expect(first.body.data.alreadyCancelled).toBe(false);
    expect(first.body.data.order.status).toBe('CANCELLED');
    expect(first.body.data.order.fulfillmentStatus).toBe('CANCELLED');
    expect(first.body.data.refund).toBeNull();
    // The typed reason is persisted on the order for fast admin display.
    expect(first.body.data.order.cancellationReason).toBe('CHANGED_MIND');

    const second = await cancelById(auth, order.id);
    expect(second.status).toBe(200);
    expect(second.body.data.alreadyCancelled).toBe(true);

    const { prisma } = await import('../src/lib/prisma.js');
    const events = await prisma.orderEvent.count({
      where: { orderId: order.id, type: 'ORDER_CANCELLED_BY_CUSTOMER' },
    });
    expect(events).toBe(1);
    // A repeat cancel must not enqueue a duplicate email.
    const notifs = await prisma.orderNotification.count({
      where: { orderId: order.id, type: 'ORDER_CANCELLED' },
    });
    expect(notifs).toBe(1);
  });

  it('409s for delivered orders and points at the return process', async () => {
    const auth = await registerAgent();
    const order = await fileOrder(auth);
    await setFulfillment(order.id, 'DELIVERED');
    const res = await cancelById(auth, order.id);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('return');
  });

  it('409s for orders already with the courier', async () => {
    const auth = await registerAgent();
    const order = await fileOrder(auth);
    await setFulfillment(order.id, 'SHIPPED');
    const res = await cancelById(auth, order.id);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('courier');
  });

  it('refunds a PAID verified order exactly once, even on a repeated request', async () => {
    const { prisma } = await import('../src/lib/prisma.js');
    const auth = await registerAgent();
    const order = await fileOrder(auth);

    await prisma.order.update({
      where: { id: order.id },
      data: { status: 'PAID', razorpayPaymentId: uniqueId('pay') },
    });

    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/refund')) return jsonResponse({ id: 'rpa_cancel_true', status: 'processed' });
      return jsonResponse({}, false);
    });

    const first = await cancelById(auth, order.id);
    expect(first.status).toBe(200);
    // Payment status stays PAID (verified money moved); fulfilment is cancelled.
    expect(first.body.data.order.status).toBe('PAID');
    expect(first.body.data.order.fulfillmentStatus).toBe('CANCELLED');
    expect(first.body.data.refund.status).toBe('SUCCESS');
    expect(first.body.data.refund.error).toBeNull();

    const refundRows = await prisma.refund.count({ where: { orderId: order.id } });
    expect(refundRows).toBe(1);
    const refund = await prisma.refund.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(refund.status).toBe('SUCCESS');
    expect(refund.providerRefundId).toBe('rpa_cancel_true');
    expect(refund.completedAt).not.toBeNull();

    const completedEvents = await prisma.orderEvent.count({
      where: { orderId: order.id, type: 'REFUND_COMPLETED' },
    });
    expect(completedEvents).toBe(1);

    // A repeat request must not create a second obligation or re-post.
    const second = await cancelById(auth, order.id);
    expect(second.status).toBe(200);
    expect(second.body.data.alreadyCancelled).toBe(true);
    const refundRowsAfter = await prisma.refund.count({ where: { orderId: order.id } });
    expect(refundRowsAfter).toBe(1);
    const refundCalls = fetchMock.mock.calls.filter((args) => String(args[0]).includes('/refund'));
    expect(refundCalls.length).toBe(1);
  });

  it('cancels a PAID order without a payment id without inventing a refund', async () => {
    const { prisma } = await import('../src/lib/prisma.js');
    const auth = await registerAgent();
    const order = await fileOrder(auth);
    await prisma.order.update({ where: { id: order.id }, data: { status: 'PAID' } });

    const res = await cancelById(auth, order.id);
    expect(res.status).toBe(200);
    expect(res.body.data.refund).toBeNull();
    const refundRows = await prisma.refund.count({ where: { orderId: order.id } });
    expect(refundRows).toBe(0);
  });
});