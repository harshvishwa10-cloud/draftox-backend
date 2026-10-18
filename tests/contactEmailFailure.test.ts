import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Express } from 'express';
import { prisma } from '../src/lib/prisma.js';
import { createApp } from '../src/app.js';
import { createAgent, uniqueEmail } from './helpers/agent.js';
import { getAdminAgent } from './helpers/admin.js';

/**
 * Contact submissions must survive an unavailable mailer. On hosts that block
 * outbound SMTP (Render Free blocks 25/465/587) sendMail resolves FAILED - the
 * inquiry stays saved, the HTTP response stays a truthful 201 that says the
 * inquiry was received, the outbox row stays FAILED/retryable, and an admin
 * retry sends at most once (never a duplicate). No real network is touched:
 * src/lib/mailer.js is mocked, exactly like shipmentEmailDelivery.test.ts and
 * passwordResetEmail.test.ts.
 */

const mailer = vi.hoisted(() => ({ sendMail: vi.fn(), isReady: true }));

vi.mock('../src/lib/mailer.js', () => ({
  get isMailerReady() {
    return mailer.isReady;
  },
  sendMail: (input: unknown) => mailer.sendMail(input),
}));

let app: Express;

beforeAll(() => {
  app = createApp();
});

beforeEach(() => {
  mailer.sendMail.mockReset();
  mailer.isReady = true;
  mailer.sendMail.mockResolvedValue({ accepted: true, messageId: 'mid-default', error: null });
});

async function submitContact() {
  const { agent, csrfToken } = await createAgent(app);
  const res = await agent.post('/api/v1/contact').set('X-CSRF-Token', csrfToken).send({
    name: 'Resilience Tester',
    email: uniqueEmail('email-fail'),
    businessName: 'Timeout Co',
    service: 'WEBSITE_DEVELOPMENT',
    budgetRange: 'FROM_25000_TO_50000',
    message: 'This enquiry must be saved even when the owner email cannot be delivered.',
  });
  expect(res.status).toBe(201);
  return res;
}

describe('POST /api/v1/contact with a failing mailer', () => {
  it('still saves the inquiry and truthfully reports ownerNotification FAILED', async () => {
    mailer.sendMail.mockResolvedValue({
      accepted: false,
      messageId: null,
      error: 'Email send timed out after 8000ms.',
    });

    const res = await submitContact();
    const inquiryId = res.body.data.inquiry.id as string;

    // Truthful: never claims the owner email was sent.
    expect(res.body.data.ownerNotification).toEqual({ status: 'FAILED', sent: false });
    // The customer-facing message still confirms the SAVED inquiry.
    expect(res.body.data.message.toLowerCase()).toContain('received');

    const saved = await prisma.contactInquiry.findUnique({ where: { id: inquiryId } });
    expect(saved).not.toBeNull();
    expect(saved!.status).toBe('NEW');

    const row = await prisma.inquiryNotification.findUniqueOrThrow({
      where: { idempotencyKey: `contact:${inquiryId}` },
    });
    expect(row.status).toBe('FAILED');
    expect(row.attempts).toBe(1);
    expect(row.error).toContain('timed out');
    expect(row.messageId).toBeNull();
  });

  it('marks the notification SENT only when the provider actually accepts', async () => {
    mailer.sendMail.mockResolvedValue({ accepted: true, messageId: 'mid-real', error: null });

    const res = await submitContact();
    const inquiryId = res.body.data.inquiry.id as string;

    expect(res.body.data.ownerNotification).toEqual({ status: 'SENT', sent: true });

    const row = await prisma.inquiryNotification.findUniqueOrThrow({
      where: { idempotencyKey: `contact:${inquiryId}` },
    });
    expect(row.status).toBe('SENT');
    expect(row.messageId).toBe('mid-real');
    expect(row.sentAt).not.toBeNull();
    expect(row.attempts).toBe(1);
  });

  it('admin retry sends exactly once and never re-sends a SENT notification', async () => {
    mailer.sendMail.mockResolvedValue({ accepted: false, messageId: null, error: 'Connection timeout' });
    const res = await submitContact();
    const inquiryId = res.body.data.inquiry.id as string;
    const row = await prisma.inquiryNotification.findUniqueOrThrow({
      where: { idempotencyKey: `contact:${inquiryId}` },
    });
    expect(row.status).toBe('FAILED');
    expect(mailer.sendMail).toHaveBeenCalledTimes(1);

    const admin = await getAdminAgent(app);

    // Provider recovers: the retry is accepted.
    mailer.sendMail.mockResolvedValue({ accepted: true, messageId: 'mid-retry', error: null });
    const retry1 = await admin.agent
      .post(`/api/v1/admin/inquiry-notifications/${row.id}/retry`)
      .set('X-CSRF-Token', admin.csrfToken);
    expect(retry1.status).toBe(200);
    expect(retry1.body.data).toMatchObject({ status: 'SENT', sent: true });
    expect(mailer.sendMail).toHaveBeenCalledTimes(2);

    // A second retry must NOT send again - idempotency guard.
    const retry2 = await admin.agent
      .post(`/api/v1/admin/inquiry-notifications/${row.id}/retry`)
      .set('X-CSRF-Token', admin.csrfToken);
    expect(retry2.status).toBe(200);
    expect(retry2.body.data).toMatchObject({ status: 'ALREADY_SENT', sent: false });
    expect(mailer.sendMail).toHaveBeenCalledTimes(2);

    const final = await prisma.inquiryNotification.findUniqueOrThrow({ where: { id: row.id } });
    expect(final.status).toBe('SENT');
    expect(final.attempts).toBe(2);
    // Exactly one inquiry - a retry can never create a duplicate.
    const inquiries = await prisma.contactInquiry.findMany({ where: { id: inquiryId } });
    expect(inquiries).toHaveLength(1);
  });

  it('when the mailer is not configured the inquiry is still saved (PENDING, retryable)', async () => {
    mailer.isReady = false;

    const res = await submitContact();
    const inquiryId = res.body.data.inquiry.id as string;

    expect(res.body.data.ownerNotification).toEqual({ status: 'NOT_CONFIGURED', sent: false });
    expect(mailer.sendMail).not.toHaveBeenCalled();

    const saved = await prisma.contactInquiry.findUnique({ where: { id: inquiryId } });
    expect(saved).not.toBeNull();

    const row = await prisma.inquiryNotification.findUniqueOrThrow({
      where: { idempotencyKey: `contact:${inquiryId}` },
    });
    expect(row.status).toBe('PENDING');
  });
});
