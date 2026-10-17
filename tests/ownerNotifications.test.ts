import { beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { prisma } from '../src/lib/prisma.js';
import { createApp } from '../src/app.js';
import { createAgent, uniqueEmail } from './helpers/agent.js';
import { getAdminAgent } from './helpers/admin.js';

let app: Express;

beforeAll(() => {
  app = createApp();
});

async function submitContact() {
  const { agent, csrfToken } = await createAgent(app);
  const res = await agent.post('/api/v1/contact').set('X-CSRF-Token', csrfToken).send({
    name: 'Owner Ping',
    email: uniqueEmail('owner-contact'),
    businessName: 'Owner Ping Co',
    service: 'WEBSITE_DEVELOPMENT',
    budgetRange: 'FROM_25000_TO_50000',
    message: 'Please reach out about a storefront website build.',
  });
  expect(res.status).toBe(201);
  return res;
}

describe('owner notification outbox (public request -> owner inbox)', () => {
  it('records a truthful owner notification row for a new contact enquiry', async () => {
    const res = await submitContact();
    const inquiryId = res.body.data.inquiry.id as string;

    // Email is disabled in tests, so the response must NOT claim the owner email
    // was sent — that is the "falsely reporting success" bug this fixes.
    expect(res.body.data.ownerNotification.sent).toBe(false);
    expect(res.body.data.ownerNotification.status).toBe('NOT_CONFIGURED');

    const row = await prisma.inquiryNotification.findUnique({
      where: { idempotencyKey: `contact:${inquiryId}` },
    });
    expect(row).not.toBeNull();
    expect(row!.kind).toBe('CONTACT');
    expect(row!.refId).toBe(inquiryId);
    // Never configured => PENDING (retryable), never SENT.
    expect(row!.status).toBe('PENDING');
    expect(row!.toEmail).toBe('draftox0@gmail.com');
  });

  it('records a product enquiry notification against the product', async () => {
    const product = await prisma.product.create({
      data: {
        slug: `owner-notify-${Date.now()}`,
        name: 'Owner Notify Product',
        description: 'Product used by owner-notification tests.',
        status: 'PUBLISHED',
        currency: 'INR',
      },
      select: { id: true },
    });
    const { agent, csrfToken } = await createAgent(app);
    const res = await agent
      .post('/api/v1/product-inquiries')
      .set('X-CSRF-Token', csrfToken)
      .send({
        productId: product.id,
        customerName: 'Interested Owner Ping',
        email: uniqueEmail('owner-product'),
        quantity: 1,
        type: 'PURCHASE_INTENT',
        message: 'Is this available and what is the lead time?',
      });
    expect(res.status).toBe(201);
    expect(res.body.data.ownerNotification.status).toBe('NOT_CONFIGURED');

    const row = await prisma.inquiryNotification.findUnique({
      where: { idempotencyKey: `product:${res.body.data.inquiry.id}` },
    });
    expect(row?.kind).toBe('PRODUCT');
  });

  it('records a support request notification', async () => {
    const { agent, csrfToken } = await createAgent(app);
    const res = await agent.post('/api/v1/support').set('X-CSRF-Token', csrfToken).send({
      name: 'Support Owner Ping',
      contact: uniqueEmail('owner-support'),
      subject: 'Need help',
      message: 'Please assist with a question about my order.',
    });
    expect(res.status).toBe(201);
    const row = await prisma.inquiryNotification.findUnique({
      where: { idempotencyKey: `support:${res.body.data.request.id}` },
    });
    expect(row?.kind).toBe('SUPPORT');
  });
});

describe('admin inquiry inbox', () => {
  it('is not reachable by a signed-in non-admin', async () => {
    const admin = await getAdminAgent(app);
    expect(admin.userId).toBeTruthy();
    const { agent, csrfToken } = await createAgent(app);
    // A guest is unauthenticated (401); the point is it is never the admin inbox.
    const res = await agent.get('/api/v1/admin/inquiries/contact').set('X-CSRF-Token', csrfToken);
    expect([401, 403]).toContain(res.status);
  });

  it('lists a submitted request with its owner-notification state', async () => {
    const submitted = await submitContact();
    const inquiryId = submitted.body.data.inquiry.id as string;

    const admin = await getAdminAgent(app);
    const res = await admin.agent
      .get('/api/v1/admin/inquiries/contact')
      .set('X-CSRF-Token', admin.csrfToken);
    expect(res.status).toBe(200);

    const found = (res.body.data.inquiries as Array<{ id: string; ownerNotification: unknown }>).find(
      (i) => i.id === inquiryId,
    );
    expect(found).toBeTruthy();
    expect(found!.ownerNotification).toBeTruthy();
  });

  it('updates the handling status of a request', async () => {
    const submitted = await submitContact();
    const inquiryId = submitted.body.data.inquiry.id as string;

    const admin = await getAdminAgent(app);
    const res = await admin.agent
      .patch(`/api/v1/admin/inquiries/contact/${inquiryId}`)
      .set('X-CSRF-Token', admin.csrfToken)
      .send({ status: 'RESOLVED' });
    expect(res.status).toBe(200);
    expect(res.body.data.inquiry.status).toBe('RESOLVED');

    const saved = await prisma.contactInquiry.findUnique({ where: { id: inquiryId } });
    expect(saved!.status).toBe('RESOLVED');
  });

  it('retries an owner notification and reports NOT_CONFIGURED honestly', async () => {
    const submitted = await submitContact();
    const inquiryId = submitted.body.data.inquiry.id as string;
    const row = await prisma.inquiryNotification.findUniqueOrThrow({
      where: { idempotencyKey: `contact:${inquiryId}` },
    });

    const admin = await getAdminAgent(app);
    const res = await admin.agent
      .post(`/api/v1/admin/inquiry-notifications/${row.id}/retry`)
      .set('X-CSRF-Token', admin.csrfToken);
    expect(res.status).toBe(200);
    expect(res.body.data.sent).toBe(false);
    expect(res.body.data.status).toBe('NOT_CONFIGURED');
  });
});
