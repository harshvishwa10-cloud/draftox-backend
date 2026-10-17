// Razorpay env must be set before src/config/env.ts is first imported so the
// admin RESOLVE-refund path works in this suite.
import './helpers/razorpay-env.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Express } from 'express';
import { createAgent, uniqueEmail, type AgentWithCsrf } from './helpers/agent.js';
import { getAdminAgent } from './helpers/admin.js';
import {
  computeReturnEligibility,
  addDays,
} from '../src/modules/returns/eligibility.js';
import {
  canTransitionReturn,
  isTerminalReturnStatus,
  actionTargetFor,
  RETURN_TRANSITIONS,
} from '../src/modules/returns/state.js';
import {
  detectImageType,
  validateReturnPhoto,
  deleteReturnPhotos,
  MAX_PHOTO_BYTES,
} from '../src/modules/returns/photos.js';

let app: Express;
let fetchMock: ReturnType<typeof vi.fn>;
const storedPhotosToCleanup: Array<{ storedName: string }> = [];
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
  await deleteReturnPhotos(storedPhotosToCleanup);
  const { prisma } = await import('../src/lib/prisma.js');
  await Promise.all(ordersToCleanup.map((id) => prisma.order.delete({ where: { id } }).catch(() => undefined)));
});

function jsonResponse(payload: unknown, ok = true) {
  return Promise.resolve({ ok, status: ok ? 200 : 400, json: async () => payload });
}

function jpegBytes(): Buffer {
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x02, 0x03]);
}

function pngBytes(): Buffer {
  return Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  ]);
}

function webpBytes(): Buffer {
  return Buffer.from([
    0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
  ]);
}

function photoInput(bytes: Buffer, kind: 'jpeg' | 'png' | 'webp', name = 'issue.jpg') {
  const mime = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[kind];
  return { name, type: mime, size: bytes.length, dataBase64: bytes.toString('base64') };
}

interface Authed extends AgentWithCsrf {
  email: string;
}

async function registerAgent(prefix = 'return'): Promise<Authed> {
  const { agent, csrfToken } = await createAgent(app);
  const email = uniqueEmail(prefix);
  const res = await agent
    .post('/api/v1/auth/register')
    .set('X-CSRF-Token', csrfToken)
    .send({ name: 'Return Person', email, password: 'testpassword1' });
  expect(res.status).toBe(201);
  return { agent, csrfToken, email };
}

interface OrderSnap {
  id: string;
  orderNumber: string | null;
}

async function fileOrder(auth: Authed): Promise<OrderSnap> {
  const { prisma } = await import('../src/lib/prisma.js');
  const product = await prisma.product.findUnique({
    where: { slug: 'draftox-16-channel' },
    select: { id: true },
  });
  if (!product) throw new Error('seeded 16-channel product missing from test DB');
  const res = await auth.agent
    .post('/api/v1/orders')
    .set('X-CSRF-Token', auth.csrfToken)
    .send({
      items: [{ productId: product.id, qty: 1 }],
      name: 'Return Person',
      email: auth.email,
      address: { line: '1 Main Street', city: 'Mumbai', state: 'Maharashtra', pincode: '400001' },
    });
  expect(res.status).toBe(201);
  const order = res.body.data.order as OrderSnap;
  ordersToCleanup.push(order.id);
  return order;
}

let idCounter = 0;
function uniqueId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}${idCounter}${Math.random().toString(36).slice(2, 7)}`;
}

async function markDelivered(orderId: string, deliveredAt: Date | null): Promise<void> {
  const { prisma } = await import('../src/lib/prisma.js');
  await prisma.order.update({
    where: { id: orderId },
    data: { fulfillmentStatus: 'DELIVERED', status: 'PAID' },
  });
  await prisma.shipment.upsert({
    where: { orderId },
    create: { orderId, deliveredAt },
    update: { deliveredAt },
  });
}

function submitReturn(auth: Authed, orderId: string, photos: ReturnType<typeof photoInput>[]) {
  return auth.agent
    .post(`/api/v1/orders/${orderId}/returns`)
    .set('X-CSRF-Token', auth.csrfToken)
    .send({ reason: 'DEFECTIVE', explanation: 'The panel powers on but one channel port produces no signal at all.', photos });
}

/* ------------------------------------------------------------------ */
/* Pure return eligibility                                             */
/* ------------------------------------------------------------------ */

describe('computeReturnEligibility', () => {
  it('blocks anything not delivered', () => {
    for (const fs of ['AWAITING_PAYMENT', 'PROCESSING', 'SHIPPED', 'CANCELLED']) {
      const r = computeReturnEligibility(fs, new Date(), 10);
      expect(r.status).toBe('NOT_DELIVERED');
    }
  });

  it('flags delivered-without-verified-timestamp for manual review', () => {
    const r = computeReturnEligibility('DELIVERED', null, 10);
    expect(r.status).toBe('ELIGIBLE');
    expect(r.needsReview).toBe(true);
  });

  it('is eligible inside the window and expired after it', () => {
    const deliveredAt = new Date('2026-01-01T00:00:00Z');
    const inside = computeReturnEligibility('DELIVERED', deliveredAt, 10, addDays(deliveredAt, 9));
    expect(inside.status).toBe('ELIGIBLE');
    expect(inside.needsReview).toBe(false);
    expect(inside.deadline).toEqual(addDays(deliveredAt, 10));

    const depends = computeReturnEligibility('DELIVERED', deliveredAt, 10, addDays(deliveredAt, 11));
    expect(depends.status).toBe('EXPIRED');
    expect(depends.needsReview).toBe(false);
  });

  it('the boundary day itself is still inside the window', () => {
    const deliveredAt = new Date('2026-01-01T00:00:00Z');
    const boundary = computeReturnEligibility('DELIVERED', deliveredAt, 10, addDays(deliveredAt, 10));
    expect(boundary.status).toBe('ELIGIBLE');
  });
});

describe('return status state machine', () => {
  it('only allows forward, terminal-closed transitions', () => {
    expect(canTransitionReturn('SUBMITTED', 'APPROVED')).toBe(true);
    expect(canTransitionReturn('SUBMITTED', 'REJECTED')).toBe(true);
    expect(canTransitionReturn('APPROVED', 'ITEM_RECEIVED')).toBe(true);
    expect(canTransitionReturn('ITEM_RECEIVED', 'RESOLVED')).toBe(true);
    expect(canTransitionReturn('RESOLVED', 'CLOSED')).toBe(true);
    expect(canTransitionReturn('APPROVED', 'SUBMITTED')).toBe(false);
    expect(canTransitionReturn('REJECTED', 'APPROVED')).toBe(false);
  });

  it('knows terminal statuses', () => {
    for (const s of ['RESOLVED', 'CLOSED', 'REJECTED']) expect(isTerminalReturnStatus(s as never)).toBe(true);
    expect(isTerminalReturnStatus('SUBMITTED' as never)).toBe(false);
  });

  it('maps admin actions to legal transitions only from their allowed statuses', () => {
    expect(actionTargetFor('APPROVE', 'SUBMITTED')).toBe('APPROVED');
    expect(actionTargetFor('APPROVE', 'APPROVED')).toBeNull();
    expect(actionTargetFor('REJECT', 'SUBMITTED')).toBe('REJECTED');
    expect(actionTargetFor('REJECT', 'APPROVED')).toBe('REJECTED');
    expect(actionTargetFor('RECEIVED', 'APPROVED')).toBe('ITEM_RECEIVED');
    expect(actionTargetFor('RECEIVED', 'SUBMITTED')).toBeNull();
    expect(actionTargetFor('RESOLVE', 'ITEM_RECEIVED')).toBe('RESOLVED');
    expect(actionTargetFor('RESOLVE', 'REJECTED')).toBeNull();
  });

  it('exposes every status in the transition map exactly once as a from-state', () => {
    expect(Object.keys(RETURN_TRANSITIONS)).toHaveLength(8);
  });
});

/* ------------------------------------------------------------------ */
/* Photo validation (pure)                                             */
/* ------------------------------------------------------------------ */

describe('validateReturnPhoto + detectImageType', () => {
  it('recognizes real JPEG, PNG and WebP magic bytes', () => {
    expect(detectImageType(jpegBytes())).toBe('jpeg');
    expect(detectImageType(pngBytes())).toBe('png');
    expect(detectImageType(webpBytes())).toBe('webp');
    expect(detectImageType(Buffer.from('definitely not an image'))).toBeNull();
  });

  it('accepts valid photos whose declared size matches the bytes', () => {
    expect(validateReturnPhoto(photoInput(jpegBytes(), 'jpeg')).ok).toBe(true);
    expect(validateReturnPhoto(photoInput(pngBytes(), 'png')).ok).toBe(true);
    expect(validateReturnPhoto(photoInput(webpBytes(), 'webp')).ok).toBe(true);
  });

  it('rejects fake images, mismatched types, wrong sizes and oversized files', () => {
    const fake = photoInput(Buffer.from('#!/bin/sh\nrm -rf'), 'jpeg', 'evil.jpg');
    expect(validateReturnPhoto(fake).ok).toBe(false);

    const mismatched = photoInput(jpegBytes(), 'png');
    expect(validateReturnPhoto(mismatched).ok).toBe(false);

    const wrongSize = { ...photoInput(jpegBytes(), 'jpeg'), size: 999 };
    expect(validateReturnPhoto(wrongSize).ok).toBe(false);

    const huge = { ...photoInput(jpegBytes(), 'jpeg'), size: MAX_PHOTO_BYTES + 1, dataBase64: Buffer.alloc(MAX_PHOTO_BYTES + 1, 0xff).toString('base64') };
    expect(validateReturnPhoto(huge).ok).toBe(false);
  });

  it('rejects empty inputs', () => {
    expect(validateReturnPhoto({ name: 'x', type: 'image/jpeg', size: 0, dataBase64: '' }).ok).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Warranty exposure                                                   */
/* ------------------------------------------------------------------ */

describe('warranty months', () => {
  it('exposes warrantyMonths on the public catalog', async () => {
    const { agent } = await createAgent(app);
    const res = await agent.get('/api/v1/products?search=16-channel');
    expect(res.status).toBe(200);
    const item = res.body.data.items.find((p: { slug: string }) => p.slug === 'draftox-16-channel');
    expect(item.warrantyMonths).toBe(6);
  });

  it('snapshots warrantyMonths into the order line item at checkout', async () => {
    const auth = await registerAgent();
    const order = await fileOrder(auth);
    const res = await auth.agent.get(`/api/v1/orders/${order.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.order.items[0].warrantyMonths).toBe(6);
  });
});

/* ------------------------------------------------------------------ */
/* Customer return-request flow                                        */
/* ------------------------------------------------------------------ */

describe('POST /api/v1/orders/:orderId/returns', () => {
  it('401s for guests', async () => {
    const { agent, csrfToken } = await createAgent(app);
    expect(
      (await agent
        .post('/api/v1/orders/whatever/returns')
        .set('X-CSRF-Token', csrfToken)
        .send({})).status,
    ).toBe(401);
  });

  it("never reveals another customer's order (404)", async () => {
    const owner = await registerAgent();
    const order = await fileOrder(owner);
    const other = await registerAgent('other');
    const res = await submitReturn(other, order.id, [photoInput(jpegBytes(), 'jpeg')]);
    expect(res.status).toBe(404);
  });

  it('409s for orders that have not been delivered', async () => {
    const auth = await registerAgent();
    const order = await fileOrder(auth);
    const res = await submitReturn(auth, order.id, [photoInput(jpegBytes(), 'jpeg')]);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('not been delivered');
  });

  it('accepts a delivered order inside the window and persists the request', async () => {
    const { prisma } = await import('../src/lib/prisma.js');
    const auth = await registerAgent();
    const order = await fileOrder(auth);
    await markDelivered(order.id, new Date(Date.now() - 24 * 60 * 60 * 1000));

    const res = await submitReturn(auth, order.id, [
      photoInput(jpegBytes(), 'jpeg', 'front.jpg'),
      photoInput(pngBytes(), 'png', 'port.png'),
    ]);
    expect(res.status).toBe(201);
    expect(res.body.data.returnRequest.status).toBe('SUBMITTED');
    expect(res.body.data.returnRequest.needsReview).toBe(false);
    expect(res.body.data.returnRequest.explanation.length).toBeGreaterThan(10);

    const row = await prisma.returnRequest.findUniqueOrThrow({
      where: { id: res.body.data.returnRequest.id },
      select: { photos: true, orderId: true },
    });
    expect(row.orderId).toBe(order.id);
    const photos = row.photos as Array<{ id: string; storedName: string }>;
    expect(photos).toHaveLength(2);
    storedPhotosToCleanup.push(...(photos as Array<{ storedName: string }>));

    const event = await prisma.orderEvent.count({
      where: { orderId: order.id, type: 'RETURN_REQUESTED' },
    });
    expect(event).toBe(1);
    const notif = await prisma.orderNotification.count({
      where: { orderId: order.id, type: 'RETURN_SUBMITTED' },
    });
    expect(notif).toBe(1);

    // A second active request on the same order is blocked.
    const duplicate = await submitReturn(auth, order.id, [photoInput(jpegBytes(), 'jpeg')]);
    expect(duplicate.status).toBe(409);
  });

  it('flags a delivered-but-unverified order for manual eligibility review', async () => {
    const auth = await registerAgent();
    const order = await fileOrder(auth);
    await markDelivered(order.id, null);

    const res = await submitReturn(auth, order.id, [photoInput(jpegBytes(), 'jpeg')]);
    expect(res.status).toBe(201);
    expect(res.body.data.returnRequest.needsReview).toBe(true);
  });

  it('409s once the return window has passed', async () => {
    const auth = await registerAgent();
    const order = await fileOrder(auth);
    await markDelivered(order.id, new Date(Date.now() - 40 * 24 * 60 * 60 * 1000));

    const res = await submitReturn(auth, order.id, [photoInput(jpegBytes(), 'jpeg')]);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('return window');
  });

  it('rejects non-image uploads and zero-photo submissions with 400', async () => {
    const auth = await registerAgent();
    const order = await fileOrder(auth);
    await markDelivered(order.id, new Date(Date.now() - 24 * 60 * 60 * 1000));

    const fake = await submitReturn(auth, order.id, [
      { name: 'evil.sh', type: 'application/x-sh', size: 3, dataBase64: Buffer.from('#!/bin').toString('base64') },
    ]);
    expect(fake.status).toBe(400);

    const empty = await auth.agent
      .post(`/api/v1/orders/${order.id}/returns`)
      .set('X-CSRF-Token', auth.csrfToken)
      .send({ reason: 'DEFECTIVE', explanation: 'Something is wrong with the panel.', photos: [] });
    expect(empty.status).toBe(422);
  });
});

/* ------------------------------------------------------------------ */
/* Admin return review + photo serving + refund on resolve             */
/* ------------------------------------------------------------------ */

describe('admin return review', () => {
  it('serves the return list and photo bytes to an admin only', async () => {
    const { prisma } = await import('../src/lib/prisma.js');
    const auth = await registerAgent();
    const order = await fileOrder(auth);
    await markDelivered(order.id, new Date(Date.now() - 24 * 60 * 60 * 1000));
    const created = await submitReturn(auth, order.id, [photoInput(jpegBytes(), 'jpeg', 'proof.jpg')]);
    expect(created.status).toBe(201);
    const returnId = created.body.data.returnRequest.id;
    const row = await prisma.returnRequest.findUniqueOrThrow({
      where: { id: returnId },
      select: { photos: true },
    });
    const photos = row.photos as Array<{ id: string; storedName: string; mime: string }>;
    storedPhotosToCleanup.push(...(photos as Array<{ storedName: string }>));

    // Customers never reach admin resources.
    expect((await auth.agent.get('/api/v1/admin/returns')).status).toBe(403);

    const admin = await getAdminAgent(app);
    const list = await admin.agent.get('/api/v1/admin/returns');
    expect(list.status).toBe(200);
    const listed = list.body.data.returnRequests.filter((r: { id: string }) => r.id === returnId);
    expect(listed).toHaveLength(1);

    const photoRes = await admin.agent.get(`/api/v1/admin/returns/${returnId}/photos/${photos[0].id}`);
    expect(photoRes.status).toBe(200);
    expect(photoRes.headers['content-type']).toContain('image/jpeg');
    expect(Buffer.isBuffer(photoRes.body)).toBe(true);
    expect(photoRes.body.length).toBeGreaterThan(0);

    // An unknown photo id is a 404, never an error.
    const missing = await admin.agent.get(`/api/v1/admin/returns/${returnId}/photos/AAAAAAAAAAAAAAAAAA`);
    expect(missing.status).toBe(404);
  });

  it('applies APPROVE then blocks a repeated approve with a conflict', async () => {
    const { prisma } = await import('../src/lib/prisma.js');
    const auth = await registerAgent();
    const order = await fileOrder(auth);
    await markDelivered(order.id, new Date(Date.now() - 24 * 60 * 60 * 1000));
    const created = await submitReturn(auth, order.id, [photoInput(jpegBytes(), 'jpeg')]);
    const returnId = created.body.data.returnRequest.id;

    const admin = await getAdminAgent(app);
    const approve = await admin.agent
      .patch(`/api/v1/admin/returns/${returnId}`)
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ action: 'APPROVE', note: 'Looks fine' });
    expect(approve.status).toBe(200);
    expect(approve.body.data.returnRequest.status).toBe('APPROVED');
    expect(approve.body.data.returnRequest.decidedBy).not.toBeNull();

    const again = await admin.agent
      .patch(`/api/v1/admin/returns/${returnId}`)
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ action: 'APPROVE' });
    expect(again.status).toBe(409);

    const events = await prisma.orderEvent.count({
      where: { orderId: order.id, type: 'RETURN_REVIEWED' },
    });
    expect(events).toBe(1);
  });

  it('requires a note when rejecting', async () => {
    const auth = await registerAgent();
    const order = await fileOrder(auth);
    await markDelivered(order.id, new Date(Date.now() - 24 * 60 * 60 * 1000));
    const created = await submitReturn(auth, order.id, [photoInput(jpegBytes(), 'jpeg')]);
    const returnId = created.body.data.returnRequest.id;

    const admin = await getAdminAgent(app);
    const noNote = await admin.agent
      .patch(`/api/v1/admin/returns/${returnId}`)
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ action: 'REJECT' });
    expect(noNote.status).toBe(400);

    const withNote = await admin.agent
      .patch(`/api/v1/admin/returns/${returnId}`)
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ action: 'REJECT', note: 'Beyond the return window' });
    expect(withNote.status).toBe(200);
    expect(withNote.body.data.returnRequest.status).toBe('REJECTED');
    expect(withNote.body.data.returnRequest.decisionNote).toBe('Beyond the return window');
  });

  it('RESOLVE of a paid verified order refunds once and completes the return', async () => {
    const { prisma } = await import('../src/lib/prisma.js');
    const auth = await registerAgent();
    const order = await fileOrder(auth);
    await markDelivered(order.id, new Date(Date.now() - 24 * 60 * 60 * 1000));
    await prisma.order.update({
      where: { id: order.id },
      data: { razorpayPaymentId: uniqueId('pay') },
    });

    const created = await submitReturn(auth, order.id, [photoInput(jpegBytes(), 'jpeg')]);
    const returnId = created.body.data.returnRequest.id;

    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/refund')) return jsonResponse({ id: 'rpa_return_ok', status: 'processed' });
      return jsonResponse({}, false);
    });

    const admin = await getAdminAgent(app);
    const approve = await admin.agent
      .patch(`/api/v1/admin/returns/${returnId}`)
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ action: 'APPROVE', note: 'Approved for return' });
    expect(approve.status).toBe(200);

    const resolve = await admin.agent
      .patch(`/api/v1/admin/returns/${returnId}`)
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ action: 'RESOLVE' });

    expect(resolve.status).toBe(200);
    expect(resolve.body.data.returnRequest.status).toBe('REFUND_COMPLETED');
    expect(resolve.body.data.refund.status).toBe('SUCCESS');

    const refundRows = await prisma.refund.count({ where: { orderId: order.id } });
    expect(refundRows).toBe(1);
    const refund = await prisma.refund.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(refund.status).toBe('SUCCESS');
    expect(refund.providerRefundId).toBe('rpa_return_ok');
  });
});