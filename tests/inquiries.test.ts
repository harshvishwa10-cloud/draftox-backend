import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { prisma } from '../src/lib/prisma.js';
import { createApp } from '../src/app.js';
import { createAgent, uniqueEmail } from './helpers/agent.js';

let app: Express;

beforeAll(() => {
  app = createApp();
});

async function createPublishedProduct(slug: string) {
  return prisma.product.create({
    data: {
      slug,
      name: 'Inquiry Test Product',
      description: 'Product used by inquiry tests.',
      status: 'PUBLISHED',
      currency: 'INR',
    },
  });
}

describe('POST /api/v1/contact', () => {
  it('creates a contact inquiry with status NEW', async () => {
    const { agent, csrfToken } = await createAgent(app);
    const res = await agent
      .post('/api/v1/contact')
      .set('X-CSRF-Token', csrfToken)
      .send({
        name: 'Contact Person',
        email: 'Contact.Person@Example.COM',
        businessName: 'Acme',
        service: 'WEBSITE_DEVELOPMENT',
        budgetRange: 'FROM_25000_TO_50000',
        message: 'We need a marketing website for our business.',
      });

    expect(res.status).toBe(201);
    expect(res.body.data.inquiry.status).toBe('NEW');
    expect(res.body.data.inquiry.id).toBeTruthy();

    const saved = await prisma.contactInquiry.findUnique({ where: { id: res.body.data.inquiry.id } });
    expect(saved).not.toBeNull();
    expect(saved!.email).toBe('contact.person@example.com');
  });

  it('rejects invalid payloads with 422 and never assigns status from the client', async () => {
    const { agent, csrfToken } = await createAgent(app);
    const bad = await agent
      .post('/api/v1/contact')
      .set('X-CSRF-Token', csrfToken)
      .send({
        name: 'X',
        email: 'invalid',
        service: 'NOT_A_SERVICE',
        message: 'short',
        status: 'RESOLVED',
      });
    expect(bad.status).toBe(422);
  });

  it('rejects over-long messages', async () => {
    const { agent, csrfToken } = await createAgent(app);
    const res = await agent
      .post('/api/v1/contact')
      .set('X-CSRF-Token', csrfToken)
      .send({
        name: 'Long Message',
        email: uniqueEmail('long'),
        service: 'OTHER',
        message: 'x'.repeat(5001),
      });
    expect(res.status).toBe(422);
  });
});

describe('POST /api/v1/product-inquiries', () => {
  it('creates an inquiry for a published product and explicitly states it is not an order', async () => {
    const product = await createPublishedProduct(`inquiry-${Date.now()}`);
    const { agent, csrfToken } = await createAgent(app);

    const res = await agent
      .post('/api/v1/product-inquiries')
      .set('X-CSRF-Token', csrfToken)
      .send({
        productId: product.id,
        customerName: 'Interested Buyer',
        email: uniqueEmail('buyer'),
        quantity: 2,
        type: 'PURCHASE_INTENT',
        message: 'I would like to know availability and pricing for two units.',
      });

    expect(res.status).toBe(201);
    expect(res.body.data.inquiry.status).toBe('NEW');
    expect(res.body.data.inquiry.product.id).toBe(product.id);
    expect(res.body.data.message.toLowerCase()).toContain('not a confirmed order');

    const saved = await prisma.productInquiry.findUnique({
      where: { id: res.body.data.inquiry.id },
    });
    expect(saved).not.toBeNull();
    expect(saved!.status).toBe('NEW');
    expect(saved!.quantity).toBe(2);
  });

  it('404s for draft or unknown products', async () => {
    const { agent, csrfToken } = await createAgent(app);
    const res = await agent
      .post('/api/v1/product-inquiries')
      .set('X-CSRF-Token', csrfToken)
      .send({
        productId: 'draftox-home-automation',
        customerName: 'No Product',
        email: uniqueEmail('noprod'),
        message: 'Is this product available yet? Waiting for release details.',
      });
    expect(res.status).toBe(404);
  });

  it('validates quantity bounds', async () => {
    const product = await createPublishedProduct(`inquiry-qty-${Date.now()}`);
    const { agent, csrfToken } = await createAgent(app);
    const res = await agent
      .post('/api/v1/product-inquiries')
      .set('X-CSRF-Token', csrfToken)
      .send({
        productId: product.id,
        customerName: 'Bad Qty',
        email: uniqueEmail('qty'),
        quantity: 0,
        message: 'Quantity validation test message body.',
      });
    expect(res.status).toBe(422);
  });
});

describe('POST /api/v1/support', () => {
  it('creates a support request', async () => {
    const { agent, csrfToken } = await createAgent(app);
    const res = await agent
      .post('/api/v1/support')
      .set('X-CSRF-Token', csrfToken)
      .send({
        name: 'Support Seeker',
        contact: uniqueEmail('support'),
        subject: 'Website issue',
        message: 'The contact form on our site seems to be failing.',
      });

    expect(res.status).toBe(201);
    expect(res.body.data.request.status).toBe('NEW');
  });

  it('accepts a phone number as contact', async () => {
    const { agent, csrfToken } = await createAgent(app);
    const res = await agent
      .post('/api/v1/support')
      .set('X-CSRF-Token', csrfToken)
      .send({
        name: 'Phone User',
        contact: '+91 98765 43210',
        subject: 'Call me back',
        message: 'Please call me back regarding my home automation inquiry.',
      });
    expect(res.status).toBe(201);
  });

  it('rejects an invalid contact value', async () => {
    const { agent, csrfToken } = await createAgent(app);
    const res = await agent
      .post('/api/v1/support')
      .set('X-CSRF-Token', csrfToken)
      .send({
        name: 'Bad Contact',
        contact: '??',
        subject: 'Nope',
        message: 'This contact value is completely invalid.',
      });
    expect(res.status).toBe(422);
  });
});

describe('GET /api/v1/health', () => {
  it('reports database connectivity', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body.data.database).toBe('connected');
    expect(res.body.data.status).toBe('ok');
  });
});
