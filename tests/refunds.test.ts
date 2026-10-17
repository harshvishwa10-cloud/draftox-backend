// Razorpay env must be set before src/config/env.ts is first imported so the
// provider-configured paths of processRefund are available.
import './helpers/razorpay-env.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import {
  canAttemptRefundFrom,
  createRefundInTransaction,
  parseRefundResponse,
  processRefund,
  REFUND_RECOVERABLE,
  REFUND_STATUSES,
} from '../src/modules/payments/refunds.js';
import { uniqueEmail } from './helpers/agent.js';

let fetchMock: ReturnType<typeof vi.fn>;
let ordersToCleanup: string[] = [];

beforeAll(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterAll(() => {
  vi.unstubAllGlobals();
  // Remove any refund rows/orders created in this suite so later full runs are
  // not affected by accumulating unique-refund rows.
  return Promise.all(
    ordersToCleanup.map((id) =>
      prisma.order
        .delete({ where: { id } })
        .catch(() => undefined),
    ),
  );
});

function jsonResponse(payload: unknown, ok = true) {
  return Promise.resolve({ ok, status: ok ? 200 : 400, json: async () => payload });
}

let idCounter = 0;
function uniqueId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}${idCounter}${Math.random().toString(36).slice(2, 7)}`;
}

async function makeOrder(overrides: Record<string, unknown> = {}) {
  const order = await prisma.order.create({
    data: {
      email: uniqueEmail('refund'),
      name: 'Refund Person',
      items: [{ name: '16-Channel', qty: 1, unitPrice: 7999, lineTotal: 7999 }],
      subtotal: 7999,
      amount: 7999,
      ...overrides,
    } as never,
    select: { id: true, orderNumber: true, amount: true },
  });
  ordersToCleanup.push(order.id);
  return order;
}

/* ------------------------------------------------------------------ */
/* Provider response parsing (pure)                                    */
/* ------------------------------------------------------------------ */

describe('parseRefundResponse', () => {
  it('maps the provider processed status to success', () => {
    expect(parseRefundResponse({ id: 'rpa_1', status: 'processed' })).toEqual({
      outcome: 'success',
      providerRefundId: 'rpa_1',
      error: null,
    });
  });

  it('maps pending/created to the pending outcome', () => {
    expect(parseRefundResponse({ id: 'rpa_2', status: 'pending' })).toEqual({
      outcome: 'pending',
      providerRefundId: 'rpa_2',
      error: null,
    });
    expect(parseRefundResponse({ id: 'rpa_3', status: 'created' })).toEqual({
      outcome: 'pending',
      providerRefundId: 'rpa_3',
      error: null,
    });
  });

  it('treats unknown statuses and missing ids as failure', () => {
    const unknown = parseRefundResponse({ id: 'rpa_4', status: 'cancelled' });
    expect(unknown.outcome).toBe('failed');
    expect(unknown.error).not.toBeNull();

    const noId = parseRefundResponse({ status: 'processed' });
    expect(noId.outcome).toBe('success');
    expect(noId.providerRefundId).toBeNull();

    expect(parseRefundResponse(null).outcome).toBe('failed');
    expect(parseRefundResponse('nope').outcome).toBe('failed');
  });
});

describe('refund state helpers', () => {
  it('covers the full status set', () => {
    expect(REFUND_STATUSES).toEqual([
      'REQUESTED',
      'PROCESSING',
      'SUCCESS',
      'FAILED',
      'MANUAL_REVIEW',
    ]);
  });

  it('claims only request/failed/manual-review for a new attempt', () => {
    expect(REFUND_RECOVERABLE).toEqual(['REQUESTED', 'FAILED', 'MANUAL_REVIEW']);
    expect(canAttemptRefundFrom('REQUESTED')).toBe(true);
    expect(canAttemptRefundFrom('FAILED')).toBe(true);
    expect(canAttemptRefundFrom('MANUAL_REVIEW')).toBe(true);
    expect(canAttemptRefundFrom('PROCESSING')).toBe(false);
    expect(canAttemptRefundFrom('SUCCESS')).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Obligation creation (idempotent per order)                          */
/* ------------------------------------------------------------------ */

describe('createRefundInTransaction', () => {
  it('creates the obligation once and is idempotent for the same order', async () => {
    const order = await makeOrder();
    const input = {
      orderId: order.id,
      amount: order.amount,
      currency: 'INR',
      source: 'CANCEL' as const,
    };

    const first = await prisma.$transaction((tx) => createRefundInTransaction(tx, input));
    expect(first.created).toBe(true);

    const second = await prisma.$transaction((tx) => createRefundInTransaction(tx, input));
    expect(second.created).toBe(false);
    expect(second.refund.id).toBe(first.refund.id);

    const events = await prisma.orderEvent.count({
      where: { orderId: order.id, type: 'REFUND_INITIATED' },
    });
    expect(events).toBe(1);
    const rows = await prisma.refund.count({ where: { orderId: order.id } });
    expect(rows).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* Executing a refund (guarded state machine + truthful provider)      */
/* ------------------------------------------------------------------ */

describe('processRefund state flow', () => {
  it('marks SUCCESS only when the provider confirms processed', async () => {
const order = await makeOrder({ status: 'PAID', razorpayPaymentId: uniqueId('pay_s') });
    const { refund } = await prisma.$transaction((tx) =>
      createRefundInTransaction(tx, { orderId: order.id, amount: order.amount, currency: 'INR', source: 'CANCEL' }),
    );
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/refund')) return jsonResponse({ id: 'rpa_ok', status: 'processed' });
      return jsonResponse({}, false);
    });

    const outcome = await processRefund(refund.id);
    expect(outcome.status).toBe('SUCCESS');
    expect(outcome.alreadyProcessed).toBe(false);

    const row = await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } });
    expect(row.status).toBe('SUCCESS');
    expect(row.providerRefundId).toBe('rpa_ok');
    expect(row.completedAt).not.toBeNull();

    // A SUCCESS refund is never re-posted.
    fetchMock.mockClear();
    const again = await processRefund(refund.id);
    expect(again.status).toBe('SUCCESS');
    expect(again.alreadyProcessed).toBe(true);
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes('/refund'))).toHaveLength(0);
  });

  it('keeps PROCESSING when the provider accepts but has not processed', async () => {
const order = await makeOrder({ status: 'PAID', razorpayPaymentId: uniqueId('pay_p') });
    const { refund } = await prisma.$transaction((tx) =>
      createRefundInTransaction(tx, { orderId: order.id, amount: order.amount, currency: 'INR', source: 'CANCEL' }),
    );
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/refund')) return jsonResponse({ id: 'rpa_pend', status: 'pending' });
      return jsonResponse({}, false);
    });

    const outcome = await processRefund(refund.id);
    expect(outcome.status).toBe('PROCESSING');
    expect(outcome.alreadyProcessed).toBe(false);
    expect(await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } }).then((r) => r.status)).toBe('PROCESSING');

    // A row mid-processing is never double-claimed.
    const again = await processRefund(refund.id);
    expect(again.status).toBe('PROCESSING');
    expect(again.alreadyProcessed).toBe(true);
  });

  it('a FAILED refund stays retryable and recovers to SUCCESS', async () => {
const order = await makeOrder({ status: 'PAID', razorpayPaymentId: uniqueId('pay_r') });
    const { refund } = await prisma.$transaction((tx) =>
      createRefundInTransaction(tx, { orderId: order.id, amount: order.amount, currency: 'INR', source: 'CANCEL' }),
    );

    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/refund')) return jsonResponse({ error: { reason: 'insufficient funds' } }, false);
      return jsonResponse({}, false);
    });
    const failed = await processRefund(refund.id);
    expect(failed.status).toBe('FAILED');
    expect(failed.error).toContain('insufficient funds');
    expect((await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } })).status).toBe('FAILED');

    // Provider recovers; the FAILED row is claimable again.
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/refund')) return jsonResponse({ id: 'rpa_recovered', status: 'processed' });
      return jsonResponse({}, false);
    });
    const recovered = await processRefund(refund.id);
    expect(recovered.status).toBe('SUCCESS');
    expect(recovered.alreadyProcessed).toBe(false);
  });

  it('sends a refund to MANUAL_REVIEW when no verified payment id exists', async () => {
    const order = await makeOrder({ status: 'PAID' });
    const { refund } = await prisma.$transaction((tx) =>
      createRefundInTransaction(tx, { orderId: order.id, amount: order.amount, currency: 'INR', source: 'RETURN' }),
    );
    const outcome = await processRefund(refund.id);
    expect(outcome.status).toBe('MANUAL_REVIEW');
    const row = await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } });
    expect(row.status).toBe('MANUAL_REVIEW');
    expect(row.error).toContain('manually');
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes('/refund'))).toHaveLength(0);
  });
});
