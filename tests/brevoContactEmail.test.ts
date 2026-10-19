// NOTE: './helpers/brevo-env.js' MUST stay the first import — it sets
// BREVO_API_KEY BEFORE src/config/env.ts is first evaluated for this file.
import './helpers/brevo-env.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Express } from 'express';
import { prisma } from '../src/lib/prisma.js';
import { createAgent, uniqueEmail } from './helpers/agent.js';

/**
 * End-to-end contact flow through the REAL mailer module (not mocked), with the
 * Brevo HTTP transport active and global.fetch stubbed. Proves that a new
 * contact enquiry is saved regardless of the provider outcome, that the outbox
 * row records provider='brevo' and the Brevo messageId, and that a Brevo
 * failure leaves the enquiry saved and the notification retryable (FAILED).
 */

let app: Express;
const fetchMock = vi.fn();

beforeAll(async () => {
  const mod = await import('../src/app.js');
  app = mod.createApp();
  vi.stubGlobal('fetch', fetchMock);
});

beforeEach(() => {
  fetchMock.mockReset();
});

afterAll(() => {
  vi.unstubAllGlobals();
});

async function submitContact() {
  const { agent, csrfToken } = await createAgent(app);
  const res = await agent.post('/api/v1/contact').set('X-CSRF-Token', csrfToken).send({
    name: 'Brevo Tester',
    email: uniqueEmail('brevo-contact'),
    businessName: 'Brevo Co',
    service: 'WEBSITE_DEVELOPMENT',
    budgetRange: 'FROM_25000_TO_50000',
    message: 'This enquiry must be delivered through the Brevo HTTP API.',
  });
  expect(res.status).toBe(201);
  return res;
}

describe('POST /api/v1/contact via the Brevo HTTP transport', () => {
  it('marks the notification SENT with provider=brevo when Brevo accepts (201)', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ messageId: 'brevo-mid-contact-1' }),
    });

    const res = await submitContact();
    const inquiryId = res.body.data.inquiry.id as string;

    expect(res.body.data.ownerNotification).toEqual({ status: 'SENT', sent: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0]! as [string];
    expect(url).toBe('https://api.brevo.com/v3/smtp/email');

    const row = await prisma.inquiryNotification.findUniqueOrThrow({
      where: { idempotencyKey: `contact:${inquiryId}` },
    });
    expect(row.status).toBe('SENT');
    expect(row.provider).toBe('brevo');
    expect(row.messageId).toBe('brevo-mid-contact-1');
    expect(row.toEmail).toBe('draftoxcustomersupport@gmail.com');

    const saved = await prisma.contactInquiry.findUnique({ where: { id: inquiryId } });
    expect(saved).not.toBeNull();
  });

  it('still saves the enquiry and records FAILED when Brevo rejects the request', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ code: 'unauthorized', message: 'Key not found' }),
    });

    const res = await submitContact();
    const inquiryId = res.body.data.inquiry.id as string;

    expect(res.body.data.ownerNotification).toEqual({ status: 'FAILED', sent: false });
    expect(res.body.data.message.toLowerCase()).toContain('received');

    const saved = await prisma.contactInquiry.findUnique({ where: { id: inquiryId } });
    expect(saved).not.toBeNull();

    const row = await prisma.inquiryNotification.findUniqueOrThrow({
      where: { idempotencyKey: `contact:${inquiryId}` },
    });
    expect(row.status).toBe('FAILED');
    expect(row.provider).toBe('brevo');
    expect(row.messageId).toBeNull();
    expect(row.attempts).toBe(1);
  });

  it('survives a network failure (fetch rejects) without losing the enquiry', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));

    const res = await submitContact();
    const inquiryId = res.body.data.inquiry.id as string;

    expect(res.body.data.ownerNotification).toEqual({ status: 'FAILED', sent: false });
    const saved = await prisma.contactInquiry.findUnique({ where: { id: inquiryId } });
    expect(saved).not.toBeNull();
  });
});
