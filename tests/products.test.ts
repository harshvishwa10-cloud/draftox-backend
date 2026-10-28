import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { prisma } from '../src/lib/prisma.js';
import { createApp } from '../src/app.js';
import { createAgent } from './helpers/agent.js';

let app: Express;

beforeAll(() => {
  app = createApp();
});

async function createPublishedProduct(slug: string) {
  return prisma.product.create({
    data: {
      slug,
      name: 'Published Product',
      description: 'A published test product.',
      status: 'PUBLISHED',
      price: 1999.0,
      currency: 'INR',
      availability: 'COMING_SOON',
      specifications: { platform: 'ESP32' },
      features: ['Remote control'],
      internalNotes: 'INTERNAL ONLY — must never appear in public API responses',
    },
  });
}

describe('GET /api/v1/products', () => {
  it('lists only published products with pagination meta', async () => {
    const slug = `pub-list-${Date.now()}`;
    await createPublishedProduct(slug);

    const res = await request(app).get('/api/v1/products');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data.items)).toBe(true);
    expect(res.body.data.meta).toHaveProperty('page');
    expect(res.body.data.meta).toHaveProperty('total');

    const slugs = res.body.data.items.map((p: { slug: string }) => p.slug);
    expect(slugs).toContain(slug);
    // Draft products (e.g. seeded Home Automation) must not be listed.
    expect(slugs).not.toContain('draftox-home-automation');
  });

  it('never exposes internalNotes on list responses', async () => {
    const unique = `InternalNotes ${Date.now()}`;
    const slug = `pub-internal-${Date.now()}`;
    await prisma.product.create({
      data: {
        slug,
        name: unique,
        description: 'A published test product with internal notes.',
        status: 'PUBLISHED',
        currency: 'INR',
        internalNotes: 'INTERNAL ONLY — must never appear in public API responses',
      },
    });

    const res = await request(app).get(`/api/v1/products?search=${encodeURIComponent(unique)}`);
    expect(res.status).toBe(200);
    const item = res.body.data.items.find((p: { slug: string }) => p.slug === slug);
    expect(item).toBeDefined();
    expect(item).not.toHaveProperty('internalNotes');
    expect(JSON.stringify(res.body)).not.toContain('INTERNAL ONLY');
  });

  it('validates pagination parameters', async () => {
    const res = await request(app).get('/api/v1/products?page=0');
    expect(res.status).toBe(422);

    const res2 = await request(app).get('/api/v1/products?limit=999');
    expect(res2.status).toBe(422);
  });
});

describe('GET /api/v1/products/:slug', () => {
  it('returns a published product by slug', async () => {
    const slug = `pub-slug-${Date.now()}`;
    const created = await createPublishedProduct(slug);

    const res = await request(app).get(`/api/v1/products/${slug}`);
    expect(res.status).toBe(200);
    expect(res.body.data.product.id).toBe(created.id);
    expect(res.body.data.product.slug).toBe(slug);
    expect(res.body.data.product).not.toHaveProperty('internalNotes');
  });

  it('404s for unpublished (draft) products', async () => {
    const res = await request(app).get('/api/v1/products/draftox-home-automation');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('404s for unknown slugs', async () => {
    const res = await request(app).get('/api/v1/products/does-not-exist');
    expect(res.status).toBe(404);
  });
});

describe('High-Voltage Series catalog', () => {
  const expected = [
    { slug: 'draftox-16-channel-hv4', price: 9989, mrp: 11589, savings: 1600, highVoltageChannels: 4 },
    { slug: 'draftox-24-channel-hv7', price: 17989, mrp: 20789, savings: 2800, highVoltageChannels: 7 },
    { slug: 'draftox-40-channel-hv10', price: 26999, mrp: 28579, savings: 1580, highVoltageChannels: 10 },
  ];

  it('lists the three high-voltage products as published preorders', async () => {
    const res = await request(app).get('/api/v1/products?limit=50');
    expect(res.status).toBe(200);

    for (const item of expected) {
      const product = res.body.data.items.find(
        (p: { slug: string }) => p.slug === item.slug,
      );
      expect(product, `${item.slug} should be listed`).toBeDefined();
      expect(product.status).toBe('PUBLISHED');
      expect(Number(product.price)).toBe(item.price);
      expect(product.availability).toBe('PREORDER');
      expect(product.specifications.highVoltageChannels).toBe(item.highVoltageChannels);
      expect(product.specifications.series).toBe('high-voltage');
      expect(product).not.toHaveProperty('internalNotes');
      expect(Number(product.mrp)).toBe(item.mrp);
      expect(Number(product.mrp)).toBeGreaterThan(Number(product.price));
      expect(Number(product.mrp) - Number(product.price)).toBe(item.savings);
    }
  });

  it('never exposes internalNotes for a high-voltage product', async () => {
    const res = await request(app).get('/api/v1/products/draftox-16-channel-hv4');
    expect(res.status).toBe(200);
    expect(res.body.data.product).not.toHaveProperty('internalNotes');
    expect(JSON.stringify(res.body)).not.toContain('contactors');
  });

  it('returns each high-voltage product by slug', async () => {
    for (const item of expected) {
      const res = await request(app).get(`/api/v1/products/${item.slug}`);
      expect(res.status).toBe(200);
      expect(res.body.data.product.slug).toBe(item.slug);
      expect(Number(res.body.data.product.price)).toBe(item.price);
      expect(res.body.data.product.specifications.highVoltageChannels).toBe(
        item.highVoltageChannels,
      );
      expect(Number(res.body.data.product.mrp)).toBe(item.mrp);
      expect(Number(res.body.data.product.mrp)).toBeGreaterThan(Number(res.body.data.product.price));
      expect(Number(res.body.data.product.mrp) - Number(res.body.data.product.price)).toBe(item.savings);
    }
  });
});

describe('CSRF protection', () => {
  it('rejects state-changing requests without a CSRF token', async () => {
    const { agent } = await createAgent(app);
    const res = await agent.post('/api/v1/contact').send({
      name: 'No CSRF',
      email: 'nocsrf@example.com',
      service: 'OTHER',
      message: 'This message should be rejected by CSRF protection.',
    });
    expect(res.status).toBe(403);
  });

  it('rejects state-changing requests with a mismatched CSRF token', async () => {
    const { agent } = await createAgent(app);
    const res = await agent
      .post('/api/v1/contact')
      .set('X-CSRF-Token', 'wrong-token-value')
      .send({
        name: 'Bad CSRF',
        email: 'badcsrf@example.com',
        service: 'OTHER',
        message: 'This message should be rejected by CSRF protection.',
      });
    expect(res.status).toBe(403);
  });
});
