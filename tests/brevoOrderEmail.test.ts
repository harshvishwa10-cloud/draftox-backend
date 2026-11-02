// NOTE: './helpers/brevo-order-env.js' MUST stay the first import — it sets
// BREVO_API_KEY (and distinct admin/business recipients) BEFORE
// src/config/env.ts is first evaluated for this file.
import './helpers/brevo-order-env.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Express } from 'express';
import { createAgent, uniqueEmail, type AgentWithCsrf } from './helpers/agent.js';

/**
 * COD order emails through the REAL mailer module with the Brevo HTTP transport
 * active and global.fetch stubbed. Proves that:
 *   - the customer confirmation, admin notification and business notification
 *     are all dispatched over Brevo's HTTPS API (no SMTP);
 *   - the outbox records provider='brevo' + the Brevo messageId honestly;
 *   - a Brevo rejection never loses the order and leaves FAILED/retryable rows;
 *   - an idempotent replay creates no second order and sends no second email;
 *   - retrying an internal notification reproduces the admin email, not the
 *     customer confirmation body.
 */

const API_KEY = 'xkeysib-test-do-not-log-order-0001';
const ADMIN = 'draftox0@gmail.com';
const BUSINESS = 'draftoxcustomersupport@gmail.com';

let app: Express;
const fetchMock = vi.fn();
const createdOrderIds: string[] = [];

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

beforeAll(async () => {
  const mod = await import('../src/app.js');
  app = mod.createApp();
  vi.stubGlobal('fetch', fetchMock);
});

beforeEach(() => {
  fetchMock.mockReset();
});

afterAll(async () => {
  vi.unstubAllGlobals();
  const { prisma } = await import('../src/lib/prisma.js');
  await Promise.all(
    createdOrderIds.map((id) => prisma.order.delete({ where: { id } }).catch(() => undefined)),
  );
});

async function registerAgent(prefix = 'brevo-order'): Promise<Authed> {
  const { agent, csrfToken } = await createAgent(app);
  const email = uniqueEmail(prefix);
  const res = await agent
    .post('/api/v1/auth/register')
    .set('X-CSRF-Token', csrfToken)
    .send({ name: 'Brevo Order Person', email, password: 'testpassword1' });
  expect(res.status).toBe(201);
  return { agent, csrfToken, email };
}

async function placeCodOrder(
  auth: Authed,
  opts: { idempotencyKey?: string; email?: string | null } = {},
) {
  const { prisma } = await import('../src/lib/prisma.js');
  const product = await prisma.product.findUniqueOrThrow({
    where: { slug: 'draftox-16-channel' },
    select: { id: true },
  });

  const payload: Record<string, unknown> = {
    items: [{ productId: product.id, qty: 1 }],
    name: 'Brevo Order Person',
    phone: '+91 98765 43210',
    address: { line: '1 Main Street', city: 'Mumbai', state: 'Maharashtra', pincode: '400001' },
    paymentMethod: 'cod',
  };
  payload.email = opts.email === undefined ? auth.email : opts.email;
  if (opts.idempotencyKey) payload.idempotencyKey = opts.idempotencyKey;

  const res = await auth.agent
    .post('/api/v1/orders')
    .set('X-CSRF-Token', auth.csrfToken)
    .send(payload);

  const orderId = res.body?.data?.order?.id as string | undefined;
  if (orderId) createdOrderIds.push(orderId);
  return res;
}

function successResponses() {
  let n = 0;
  return () =>
    Promise.resolve({
      ok: true,
      status: 201,
      json: async () => ({ messageId: `mid-order-${++n}` }),
    });
}

function brevoBodies(): BrevoBody[] {
  return fetchMock.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string) as BrevoBody);
}

function bodyFor(recipient: string): BrevoBody {
  const found = brevoBodies().find((b) => b.to[0]?.email === recipient);
  if (!found) throw new Error(`No Brevo message addressed to ${recipient}`);
  return found;
}

describe('COD order notifications via the Brevo HTTP transport', () => {
  it('sends customer, admin and business emails and records provider=brevo', async () => {
    const auth = await registerAgent();
    fetchMock.mockImplementation(successResponses());

    const res = await placeCodOrder(auth);

    expect(res.status).toBe(201);
    const order = res.body.data.order as { id: string; orderNumber: string; amount: number };
    expect(res.body.data.email).toEqual({ status: 'SENT', sent: true, error: null });

    // Exactly three messages: customer + admin + business.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const [url, init] of fetchMock.mock.calls as Array<[string, RequestInit]>) {
      expect(url).toBe('https://api.brevo.com/v3/smtp/email');
      expect(init.method).toBe('POST');
      const headers = init.headers as Record<string, string>;
      expect(headers['api-key']).toBe(API_KEY);
      expect(headers['content-type']).toBe('application/json');
      expect(headers.accept).toBe('application/json');
    }

    expect(new Set(brevoBodies().map((b) => b.to[0]!.email))).toEqual(
      new Set([auth.email, ADMIN, BUSINESS]),
    );

    const customer = bodyFor(auth.email);
    expect(customer.sender).toEqual({ email: 'harshvishwa10@gmail.com', name: 'DRAFTOX' });
    expect(customer.subject).toBe(`Your DRAFTOX order #${order.orderNumber} is confirmed`);
    expect(customer.textContent).toContain('Cash on Delivery');
    expect(customer.textContent).toContain('No online payment was taken');

    const admin = bodyFor(ADMIN);
    expect(admin.subject).toBe(`New DRAFTOX Order — #${order.orderNumber}`);
    expect(admin.textContent).toContain('1 Main Street');
    expect(admin.textContent).toContain('Cash on Delivery');
    expect(admin.textContent).toContain(`#${order.orderNumber}`);

    const business = bodyFor(BUSINESS);
    expect(business.subject).toBe(`New DRAFTOX Order — #${order.orderNumber}`);

    const { prisma } = await import('../src/lib/prisma.js');
    const rows = await prisma.orderNotification.findMany({ where: { orderId: order.id } });
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.status).toBe('SENT');
      expect(row.provider).toBe('brevo');
      expect(row.messageId).toMatch(/^mid-order-/);
      expect(row.attempts).toBe(1);
      expect(row.sentAt).not.toBeNull();
    }
    expect(new Set(rows.map((r) => r.idempotencyKey))).toEqual(
      new Set([
        `confirm:${order.id}`,
        `admin-confirm:${order.id}:${ADMIN}`,
        `business-confirm:${order.id}:${BUSINESS}`,
      ]),
    );
  });

  it('keeps the persisted order and records FAILED rows when Brevo rejects', async () => {
    const auth = await registerAgent('brevo-order-reject');
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ code: 'unauthorized', message: 'Key not found' }),
    });

    const res = await placeCodOrder(auth);

    expect(res.status).toBe(201);
    const order = res.body.data.order as { id: string };
    expect(res.body.data.email).toEqual({
      status: 'FAILED',
      sent: false,
      error: expect.stringContaining('401'),
    });

    const { prisma } = await import('../src/lib/prisma.js');
    const persisted = await prisma.order.findUnique({ where: { id: order.id } });
    expect(persisted).not.toBeNull();

    const rows = await prisma.orderNotification.findMany({ where: { orderId: order.id } });
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.status).toBe('FAILED');
      expect(row.provider).toBe('brevo');
      expect(row.messageId).toBeNull();
      expect(row.error).toContain('401');
      expect(row.attempts).toBe(1);
    }
  });

  it('an idempotent replay creates no second order and sends no second email', async () => {
    const auth = await registerAgent('brevo-order-dup');
    fetchMock.mockImplementation(successResponses());
    const idempotencyKey = `dup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const first = await placeCodOrder(auth, { idempotencyKey });
    expect(first.status).toBe(201);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const second = await placeCodOrder(auth, { idempotencyKey });
    expect(second.status).toBe(200);
    expect(second.body.data.idempotentReplay).toBe(true);
    expect(second.body.data.order.id).toBe(first.body.data.order.id);

    // No extra messages for the replay.
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const { prisma } = await import('../src/lib/prisma.js');
    const orders = await prisma.order.findMany({ where: { idempotencyKey } });
    expect(orders).toHaveLength(1);
    const rows = await prisma.orderNotification.count({ where: { orderId: first.body.data.order.id } });
    expect(rows).toBe(3);
  });

  it('rejects a missing customer email before creating an order or sending mail', async () => {
    const auth = await registerAgent('brevo-order-noemail');
    fetchMock.mockImplementation(successResponses());

    const res = await placeCodOrder(auth, { email: null });

    expect(res.status).toBe(422);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('retries an internal notification with the admin new-order body, never the customer copy', async () => {
    const auth = await registerAgent('brevo-order-retry');
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ code: 'unauthorized', message: 'Key not found' }),
    });

    const res = await placeCodOrder(auth);
    const orderId = res.body.data.order.id as string;

    const { prisma } = await import('../src/lib/prisma.js');
    const adminRow = await prisma.orderNotification.findFirstOrThrow({
      where: { orderId, idempotencyKey: `admin-confirm:${orderId}:${ADMIN}` },
    });
    expect(adminRow.status).toBe('FAILED');

    fetchMock.mockReset();
    fetchMock.mockImplementation(successResponses());

    const { retryOrderNotification } = await import('../src/modules/orders/orderEmails.js');
    const outcome = await retryOrderNotification(adminRow.id);
    expect(outcome).toBe('SENT');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const retried = brevoBodies()[0]!;
    expect(retried.to[0]!.email).toBe(ADMIN);
    expect(retried.subject).toContain('New DRAFTOX Order');
    expect(retried.textContent).toContain('A new DRAFTOX order has been placed.');
    expect(retried.textContent).not.toContain('Your DRAFTOX order');

    const updated = await prisma.orderNotification.findUniqueOrThrow({ where: { id: adminRow.id } });
    expect(updated.status).toBe('SENT');
    expect(updated.provider).toBe('brevo');
    expect(updated.attempts).toBe(2);

    // A second retry is a no-op: already accepted, never re-sent.
    const again = await retryOrderNotification(adminRow.id);
    expect(again).toBe('ALREADY_SENT');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
