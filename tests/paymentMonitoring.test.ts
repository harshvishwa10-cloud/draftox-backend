// Razorpay env first so provider-configured modules evaluate consistently.
import './helpers/razorpay-env.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Express } from 'express';
import { createAgent, uniqueEmail } from './helpers/agent.js';
import { getAdminAgent } from './helpers/admin.js';
import { registerAlertSink, resetAlertState, isAlertActive, setAlertCooldown, type Alert } from '../src/lib/alerts.js';
import {
  REFUND_SLA_HOURS,
  checkRefundSla,
  countRefundsAtRisk,
  refundSlaCutoff,
  reportReconcileOutcome,
} from '../src/modules/payments/monitoring.js';

let app: Express;
const HOUR = 60 * 60 * 1000;
let orderIds: string[] = [];

function makeSink() {
  const alerts: Alert[] = [];
  const sink = {
    send: vi.fn(async (alert: Alert) => {
      alerts.push(alert);
      return { delivered: true };
    }),
    alerts,
  };
  return sink;
}

let currentSink: ReturnType<typeof makeSink>;

beforeAll(async () => {
  const mod = await import('../src/app.js');
  app = mod.createApp();
});

beforeEach(() => {
  resetAlertState();
  setAlertCooldown(0);
  currentSink = makeSink();
  registerAlertSink(currentSink);
});

afterEach(() => {
  resetAlertState();
});

afterAll(async () => {
  const { prisma } = await import('../src/lib/prisma.js');
  await Promise.all(orderIds.map((id) => prisma.order.delete({ where: { id } }).catch(() => undefined)));
  orderIds = [];
});

async function makeOrderWithRefund(
  overrides: { status?: string; createdAt?: Date; refundStatus?: string } = {},
): Promise<{ orderId: string; refundId: string }> {
  const { prisma } = await import('../src/lib/prisma.js');
  const order = await prisma.order.create({
    data: {
      email: uniqueEmail('monitor'),
      name: 'Monitoring Person',
      items: [{ name: '16-Channel', qty: 1, unitPrice: 7999, lineTotal: 7999 }],
      subtotal: 7999,
      amount: 7999,
      status: overrides.status ?? 'PAID',
    } as never,
    select: { id: true },
  });
  orderIds.push(order.id);
  const refund = await prisma.refund.create({
    data: {
      orderId: order.id,
      amount: 7999,
      currency: 'INR',
      status: (overrides.refundStatus ?? 'REQUESTED') as never,
      createdAt: overrides.createdAt ?? new Date(),
    },
    select: { id: true },
  });
  return { orderId: order.id, refundId: refund.id };
}

describe('refundSlaCutoff', () => {
  it('is REFUND_SLA_HOURS before the given time', () => {
    const now = Date.UTC(2026, 0, 10, 12, 0, 0);
    expect(refundSlaCutoff(now).getTime()).toBe(now - REFUND_SLA_HOURS * HOUR);
    expect(REFUND_SLA_HOURS).toBe(24);
  });
});

describe('countRefundsAtRisk / checkRefundSla', () => {
  it('counts only non-SUCCESS refunds older than the goal', async () => {
    const now = Date.now();
    const before = await countRefundsAtRisk(now);

    await makeOrderWithRefund({ createdAt: new Date(now - 25 * HOUR), refundStatus: 'REQUESTED' });
    await makeOrderWithRefund({ createdAt: new Date(now - 48 * HOUR), refundStatus: 'PROCESSING' });
    // SUCCESS is complete and must never count, even when old.
    await makeOrderWithRefund({ createdAt: new Date(now - 72 * HOUR), refundStatus: 'SUCCESS' });
    // Recent and still pending — not past the goal yet.
    await makeOrderWithRefund({ createdAt: new Date(now - 1 * HOUR), refundStatus: 'REQUESTED' });

    const after = await countRefundsAtRisk(now);
    expect(after).toBe(before + 2);
  });

  it('raises the refund SLA alert when refunds are past the goal', async () => {
    const now = Date.now();
    await makeOrderWithRefund({ createdAt: new Date(now - 30 * HOUR) });

    const atRisk = await checkRefundSla(now);
    expect(atRisk).toBeGreaterThanOrEqual(1);
    expect(currentSink.alerts.some((a) => a.key === 'refund_sla_breach')).toBe(true);
    expect(isAlertActive('refund_sla_breach')).toBe(true);
  });

  it('reports at least the accumulated at-risk count without throwing', async () => {
    const now = Date.now();
    const before = await countRefundsAtRisk(now);
    await makeOrderWithRefund({ createdAt: new Date(now - 26 * HOUR) });
    await expect(checkRefundSla(now)).resolves.toBeGreaterThanOrEqual(before + 1);
  });
});

describe('reportReconcileOutcome', () => {
  it('alerts when a sweep reports failures', async () => {
    await reportReconcileOutcome(
      { scanned: 10, reconciled: 3, pending: 4, failed: 3 } as never,
      Date.now(),
    );
    const raised = currentSink.alerts.find((a) => a.key === 'reconcile_job_failed');
    expect(raised).toBeTruthy();
    expect(raised?.metadata).toMatchObject({ failed: 3, scanned: 10 });
  });

  it('is a no-op (no new alert) when a sweep has no failures', async () => {
    await reportReconcileOutcome(
      { scanned: 10, reconciled: 6, pending: 4, failed: 0 } as never,
      Date.now(),
    );
    expect(currentSink.alerts.filter((a) => a.key === 'reconcile_job_failed')).toHaveLength(0);
    expect(isAlertActive('reconcile_job_failed')).toBe(false);
  });
});

describe('admin refunds endpoint', () => {
  it('lists refunds past the goal with a safe order summary and atRisk flag', async () => {
    const admin = await getAdminAgent(app);
    const now = Date.now();
    const { refundId } = await makeOrderWithRefund({ createdAt: new Date(now - 30 * HOUR) });

    const res = await admin.agent.get('/api/v1/admin/refunds?atRisk=true&limit=50');
    expect(res.status).toBe(200);
    expect(res.body.data.refundSlaHours).toBe(REFUND_SLA_HOURS);
    expect(typeof res.body.data.counts.atRisk).toBe('number');

    const row = (res.body.data.refunds as Array<{ id: string; atRisk: boolean; hoursSinceCreated: number; order: { email: string } | null }>).find(
      (r) => r.id === refundId,
    );
    expect(row).toBeTruthy();
    expect(row!.atRisk).toBe(true);
    expect(row!.hoursSinceCreated).toBeGreaterThanOrEqual(24);
    expect(row!.order?.email).toBeTruthy();
  });

  it('401s for guests and 403s for ordinary customers', async () => {
    const { agent: guest } = await createAgent(app);
    expect((await guest.get('/api/v1/admin/refunds')).status).toBe(401);
    expect((await guest.get('/api/v1/admin/payment-exceptions')).status).toBe(401);
    expect((await guest.get('/api/v1/admin/payments/summary')).status).toBe(401);

    const { agent: customer, csrfToken } = await createAgent(app);
    const reg = await customer
      .post('/api/v1/auth/register')
      .set('X-CSRF-Token', csrfToken)
      .send({ name: 'Plain Customer', email: uniqueEmail('plain'), password: 'testpassword1' });
    expect(reg.status).toBe(201);
    expect((await customer.get('/api/v1/admin/refunds')).status).toBe(403);
    expect((await customer.get('/api/v1/admin/payment-exceptions')).status).toBe(403);
    expect((await customer.get('/api/v1/admin/payments/summary')).status).toBe(403);
    expect(
      (await customer
        .post('/api/v1/admin/orders/does-not-exist/reconcile-payment')
        .set('X-CSRF-Token', csrfToken)
        .send({})).status,
    ).toBe(403);
  });
});
