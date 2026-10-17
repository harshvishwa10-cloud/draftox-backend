import { beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';
import { createApp } from '../src/app.js';

let app: Express;

beforeAll(() => {
  app = createApp();
});

// The public dev origin that the frontend is served from.
const ALLOWED_ORIGIN = 'http://localhost:3000';

describe('CORS preflight for the storefront origin', () => {
  it('allows PUT /api/v1/cart from http://localhost:3000', async () => {
    const res = await request(app)
      .options('/api/v1/cart')
      .set('Origin', ALLOWED_ORIGIN)
      .set('Access-Control-Request-Method', 'PUT')
      .set('Access-Control-Request-Headers', 'content-type,x-csrf-token');

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
    expect(res.headers['access-control-allow-credentials']).toBe('true');

    const allowedMethods = (res.headers['access-control-allow-methods'] || '').toLowerCase();
    expect(allowedMethods).toContain('put');
    expect(allowedMethods).toContain('delete');
    expect(allowedMethods).toContain('post');
  });

  it('allows DELETE /api/v1/cart/:slug from http://localhost:3000', async () => {
    const res = await request(app)
      .options('/api/v1/cart/draftox-16-channel')
      .set('Origin', ALLOWED_ORIGIN)
      .set('Access-Control-Request-Method', 'DELETE')
      .set('Access-Control-Request-Headers', 'content-type');

    expect(res.status).toBe(204);
    const allowedMethods = (res.headers['access-control-allow-methods'] || '').toLowerCase();
    expect(allowedMethods).toContain('delete');
  });

  it('rejects requests from an unknown origin', async () => {
    const res = await request(app)
      .options('/api/v1/cart')
      .set('Origin', 'https://evil.example')
      .set('Access-Control-Request-Method', 'PUT');

    // The cors middleware calls callback(null, false) → Express denies the origin.
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('reflects the allowed origin on a normal GET /api/v1/products', async () => {
    const res = await request(app)
      .get('/api/v1/products')
      .set('Origin', ALLOWED_ORIGIN);

    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });
});
