import { beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { createAgent, uniqueEmail } from './helpers/agent.js';

let app: Express;

beforeAll(() => {
  app = createApp();
});

async function registerAgent() {
  const { agent, csrfToken } = await createAgent(app);
  const email = uniqueEmail('account');
  const res = await agent
    .post('/api/v1/auth/register')
    .set('X-CSRF-Token', csrfToken)
    .send({ name: 'Account User', email, password: 'testpassword1' });
  expect(res.status).toBe(201);
  return { agent, csrfToken, email };
}

const validAddress = {
  label: 'Home',
  line: '1 Main Road, Andheri West',
  city: 'Mumbai',
  state: 'Maharashtra',
  pincode: '400001',
};

describe('GET /api/v1/cart (auth)', () => {
  it('401s for guests', async () => {
    const { agent } = await createAgent(app);
    const res = await agent.get('/api/v1/cart');
    expect(res.status).toBe(401);
  });

  it('starts empty for a fresh user', async () => {
    const { agent } = await registerAgent();
    const res = await agent.get('/api/v1/cart');
    expect(res.status).toBe(200);
    expect(res.body.data.items).toEqual([]);
    expect(res.body.data.subtotal).toBe(0);
  });
});

describe('PUT /api/v1/cart (auth)', () => {
  it('stores the cart and returns server-computed prices', async () => {
    const { agent, csrfToken } = await registerAgent();
    const res = await agent
      .put('/api/v1/cart')
      .set('X-CSRF-Token', csrfToken)
      .send({ items: [{ slug: 'draftox-16-channel', qty: 2 }] });
    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0].slug).toBe('draftox-16-channel');
    expect(res.body.data.items[0].qty).toBe(2);
    // Server-authoritative pricing: seeded DB price 7999 x 2 = 15998.
    expect(Number(res.body.data.subtotal)).toBe(15998);
    expect(Number(res.body.data.items[0].product.price)).toBe(7999);
  });

  it('rejects unavailable or unpublished products', async () => {
    const { agent, csrfToken } = await registerAgent();
    const res = await agent
      .put('/api/v1/cart')
      .set('X-CSRF-Token', csrfToken)
      .send({ items: [{ slug: 'draftox-home-automation', qty: 1 }] });
    expect(res.status).toBe(400);
  });

  it('replaces the whole cart (no stale merge) and collapses duplicates', async () => {
    const { agent, csrfToken } = await registerAgent();
    await agent
      .put('/api/v1/cart')
      .set('X-CSRF-Token', csrfToken)
      .send({ items: [{ slug: 'draftox-16-channel', qty: 1 }] });
    const replace = await agent
      .put('/api/v1/cart')
      .set('X-CSRF-Token', csrfToken)
      .send({ items: [{ slug: 'draftox-24-channel', qty: 3 }, { slug: 'draftox-24-channel', qty: 5 }] });
    expect(replace.status).toBe(200);
    expect(replace.body.data.items).toHaveLength(1);
    expect(replace.body.data.items[0].qty).toBe(5);
    expect(replace.body.data.items[0].slug).toBe('draftox-24-channel');
  });

  it('rejects invalid payloads (qty out of range)', async () => {
    const { agent, csrfToken } = await registerAgent();
    const res = await agent
      .put('/api/v1/cart')
      .set('X-CSRF-Token', csrfToken)
      .send({ items: [{ slug: 'draftox-16-channel', qty: 0 }] });
    expect(res.status).toBe(422);
  });

  it('isolates carts between users', async () => {
    const one = await registerAgent();
    await one.agent
      .put('/api/v1/cart')
      .set('X-CSRF-Token', one.csrfToken)
      .send({ items: [{ slug: 'draftox-16-channel', qty: 1 }] });
    const two = await registerAgent();
    const res = await two.agent.get('/api/v1/cart');
    expect(res.body.data.items).toEqual([]);
  });
});

describe('Cart removal', () => {
  it('deletes a single item and can clear everything', async () => {
    const { agent, csrfToken } = await registerAgent();
    await agent
      .put('/api/v1/cart')
      .set('X-CSRF-Token', csrfToken)
      .send({ items: [{ slug: 'draftox-16-channel', qty: 1 }, { slug: 'draftox-24-channel', qty: 1 }] });

    const remove = await agent
      .delete('/api/v1/cart/draftox-16-channel')
      .set('X-CSRF-Token', csrfToken);
    expect(remove.status).toBe(200);
    expect(remove.body.data.items.map((i: { slug: string }) => i.slug)).toEqual([
      'draftox-24-channel',
    ]);

    const clear = await agent.delete('/api/v1/cart').set('X-CSRF-Token', csrfToken);
    expect(clear.status).toBe(200);
    expect(clear.body.data.items).toEqual([]);
  });
});

describe('Addresses CRUD (auth)', () => {
  it('creates, lists, updates and deletes own addresses', async () => {
    const { agent, csrfToken } = await registerAgent();

    const created = await agent.post('/api/v1/addresses').set('X-CSRF-Token', csrfToken).send(validAddress);
    expect(created.status).toBe(201);
    const id = created.body.data.address.id as string;

    const list = await agent.get('/api/v1/addresses');
    expect(list.status).toBe(200);
    expect(list.body.data.addresses.map((a: { id: string }) => a.id)).toContain(id);

    const updated = await agent
      .put(`/api/v1/addresses/${id}`)
      .set('X-CSRF-Token', csrfToken)
      .send({ ...validAddress, label: 'Office', line: '9 Business Park, Bandra' });
    expect(updated.status).toBe(200);
    expect(updated.body.data.address.label).toBe('Office');
    expect(updated.body.data.address.line).toBe('9 Business Park, Bandra');

    const deleted = await agent.delete(`/api/v1/addresses/${id}`).set('X-CSRF-Token', csrfToken);
    expect(deleted.status).toBe(200);
    const after = await agent.get('/api/v1/addresses');
    expect(after.body.data.addresses.map((a: { id: string }) => a.id)).not.toContain(id);
  });

  it('rejects bad pincode with 422', async () => {
    const { agent, csrfToken } = await registerAgent();
    const res = await agent
      .post('/api/v1/addresses')
      .set('X-CSRF-Token', csrfToken)
      .send({ ...validAddress, pincode: '12' });
    expect(res.status).toBe(422);
  });

  it('enforces ownership: another user gets 404 on update and delete', async () => {
    const owner = await registerAgent();
    const created = await owner.agent
      .post('/api/v1/addresses')
      .set('X-CSRF-Token', owner.csrfToken)
      .send(validAddress);
    const id = created.body.data.address.id as string;

    const other = await registerAgent();
    const upd = await other.agent
      .put(`/api/v1/addresses/${id}`)
      .set('X-CSRF-Token', other.csrfToken)
      .send(validAddress);
    expect(upd.status).toBe(404);
    const del = await other.agent
      .delete(`/api/v1/addresses/${id}`)
      .set('X-CSRF-Token', other.csrfToken);
    expect(del.status).toBe(404);
  });
});

describe('Authenticated inquiry history', () => {
  it('lists only the signed-in user’s contact, product and support submissions', async () => {
    const { agent, csrfToken, email } = await registerAgent();

    const contact = await agent
      .post('/api/v1/contact')
      .set('X-CSRF-Token', csrfToken)
      .send({
        name: 'Account User',
        email,
        service: 'WEBSITE_DEVELOPMENT',
        message: 'I would like a marketing website for my business.',
      });
    expect(contact.status).toBe(201);

    const { prisma } = await import('../src/lib/prisma.js');
    const product = await prisma.product.findUnique({
      where: { slug: 'draftox-16-channel' },
      select: { id: true },
    });
    const productInquiry = await agent
      .post('/api/v1/product-inquiries')
      .set('X-CSRF-Token', csrfToken)
      .send({
        productId: product!.id,
        customerName: 'Account User',
        email,
        quantity: 1,
        type: 'PURCHASE_INTENT',
        message: 'Checking availability for a single 16-channel unit.',
      });
    expect(productInquiry.status).toBe(201);

    const support = await agent
      .post('/api/v1/support')
      .set('X-CSRF-Token', csrfToken)
      .send({
        name: 'Account User',
        contact: email,
        subject: 'Order status follow-up',
        message: 'Please help me with an update on my home automation order.',
      });
    expect(support.status).toBe(201);

    const contactList = await agent.get('/api/v1/contact');
    expect(contactList.status).toBe(200);
    expect(contactList.body.data.inquiries.map((i: { id: string }) => i.id)).toContain(
      contact.body.data.inquiry.id,
    );

    const productList = await agent.get('/api/v1/product-inquiries');
    expect(productList.status).toBe(200);
    expect(productList.body.data.inquiries.map((i: { id: string }) => i.id)).toContain(
      productInquiry.body.data.inquiry.id,
    );

    const supportList = await agent.get('/api/v1/support');
    expect(supportList.status).toBe(200);
    expect(supportList.body.data.requests.map((r: { id: string }) => r.id)).toContain(
      support.body.data.request.id,
    );
  });

  it('does not leak another user’s inquiries', async () => {
    const one = await registerAgent();
    const other = await registerAgent();
    const { prisma } = await import('../src/lib/prisma.js');
    const product = await prisma.product.findUnique({
      where: { slug: 'draftox-16-channel' },
      select: { id: true },
    });

    await one.agent
      .post('/api/v1/product-inquiries')
      .set('X-CSRF-Token', one.csrfToken)
      .send({
        productId: product!.id,
        customerName: 'One User',
        email: one.email,
        message: 'This inquiry belongs to user one only.',
      });

    const list = await other.agent.get('/api/v1/product-inquiries');
    expect(list.status).toBe(200);
    expect(list.body.data.inquiries).toEqual([]);
  });
});