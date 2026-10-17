import { isMailerReady, sendMail } from '../../lib/mailer.js';
import { logger } from '../../lib/logger.js';
import { isTest, ownerNotificationEmail, supportEmail } from '../../config/env.js';
import { ApiError } from '../../utils/ApiError.js';
import { prisma } from '../../lib/prisma.js';
import {
  detailRow,
  detailTable,
  escapeHtml,
  renderLayout,
  type DeliveryOutcome,
  type DeliveryStatus,
  type MailInput,
} from '../shipping/notifications.js';

/**
 * Store-owner notifications for NEW public requests (contact enquiry, product
 * enquiry, support request). They mirror the shipment/order email pattern:
 *
 *   - an outbox row (InquiryNotification) is persisted PENDING BEFORE any send,
 *     so a failed delivery is auditable and retryable, never silently lost;
 *   - delivery state is honest: SENT means the provider ACCEPTED the message,
 *     NOT_CONFIGURED when SMTP is off, FAILED when the provider rejected it;
 *   - a stable idempotencyKey per request guarantees at most one notification;
 *   - senders never throw; failures are captured and reported truthfully.
 *
 * These are ADMIN-facing notifications only. The public request is always
 * persisted first — the owner email is best-effort and never blocks or fails
 * the customer's submission.
 */

export type OwnerInquiryKind = 'CONTACT' | 'PRODUCT' | 'SUPPORT';

export interface OwnerInquiryMeta {
  label: string;
  value: string | null | undefined;
}

export interface OwnerInquirySummary {
  kind: OwnerInquiryKind;
  refId: string;
  /** Human heading, e.g. "New contact enquiry". */
  heading: string;
  name: string;
  email: string;
  phone?: string | null;
  subject?: string | null;
  message: string;
  meta?: OwnerInquiryMeta[];
}

const KIND_LABEL: Record<OwnerInquiryKind, string> = {
  CONTACT: 'contact enquiry',
  PRODUCT: 'product enquiry',
  SUPPORT: 'support request',
};

/** Builds the owner-facing email for one public request. */
export function buildOwnerInquiryEmail(summary: OwnerInquirySummary): MailInput {
  const who = summary.name.trim() || 'A visitor';
  const subject =
    summary.subject?.trim() ||
    `New DRAFTOX ${KIND_LABEL[summary.kind]} from ${who}`;

  const meta = (summary.meta ?? []).filter((m) => m.value !== null && m.value !== undefined && m.value !== '');
  const details = detailTable([
    detailRow('Name', summary.name || '—'),
    detailRow('Email', summary.email || '—'),
    ...(summary.phone ? [detailRow('Phone', summary.phone)] : []),
    ...(summary.subject ? [detailRow('Subject', summary.subject)] : []),
    ...meta.map((m) => detailRow(m.label, String(m.value))),
    detailRow('Request ID', summary.refId),
  ]);

  const body = `<p style="margin:0 0 12px;">A new DRAFTOX ${escapeHtml(KIND_LABEL[summary.kind])} was submitted on the website.</p>
<h2 style="margin:16px 0 6px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;font-weight:700;color:#0b1b33;">Details</h2>
${details}
<h2 style="margin:20px 0 6px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;font-weight:700;color:#0b1b33;">Message</h2>
<p style="margin:0;white-space:pre-wrap;">${escapeHtml(summary.message)}</p>
<p style="margin:20px 0 0;color:#6b7280;font-size:13px;">Reply directly to this enquiry, or open the admin inbox to mark it handled. This is an automated notification.</p>`;

  const metaText = meta.map((m) => `${m.label}: ${m.value}`).join('\n');

  return {
    to: ownerNotificationEmail,
    subject,
    html: renderLayout(subject, summary.heading, body),
    text: `A new DRAFTOX ${KIND_LABEL[summary.kind]} was submitted on the website.

Name: ${summary.name}
Email: ${summary.email}
${summary.phone ? `Phone: ${summary.phone}\n` : ''}${summary.subject ? `Subject: ${summary.subject}\n` : ''}${metaText ? `${metaText}\n` : ''}Request ID: ${summary.refId}

Message:
${summary.message}

Reply directly to this enquiry, or open the admin inbox to mark it handled.
Support address: ${supportEmail}`,
  };
}

export interface SendOwnerInquiryEmailParams {
  kind: OwnerInquiryKind;
  refId: string;
  mail: MailInput;
  /** Stable per-request key so a retried request can never send a duplicate. */
  idempotencyKey: string;
}

/** Persists the outbox row and attempts delivery. Never throws on send failure. */
export async function sendOwnerInquiryEmail(
  params: SendOwnerInquiryEmailParams,
): Promise<DeliveryOutcome> {
  const provider = isMailerReady ? 'smtp' : null;
  const recipient = (params.mail.to ?? '').trim();

  let rowId: string;
  const existing = await prisma.inquiryNotification.findUnique({
    where: { idempotencyKey: params.idempotencyKey },
    select: { id: true, status: true },
  });
  if (existing) {
    if (existing.status === 'SENT') {
      return { status: 'ALREADY_SENT', notificationId: existing.id, messageId: null, error: null };
    }
    rowId = existing.id;
  } else {
    const created = await prisma.inquiryNotification.create({
      data: {
        kind: params.kind,
        refId: params.refId,
        toEmail: recipient,
        subject: params.mail.subject.slice(0, 200),
        status: 'PENDING',
        provider,
        idempotencyKey: params.idempotencyKey,
      },
      select: { id: true },
    });
    rowId = created.id;
  }

  if (!recipient) {
    await prisma.inquiryNotification.update({
      where: { id: rowId },
      data: { status: 'FAILED', error: 'No owner notification address is configured.' },
    });
    return {
      status: 'NO_RECIPIENT',
      notificationId: rowId,
      messageId: null,
      error: 'No owner notification address is configured.',
    };
  }

  if (!isMailerReady) {
    logger.warn('owner_mail_skipped_provider_not_configured', { kind: params.kind, refId: params.refId, notificationId: rowId });
    return {
      status: 'NOT_CONFIGURED',
      notificationId: rowId,
      messageId: null,
      error: 'Email delivery is not configured on the server.',
    };
  }

  logger.info('owner_mail_send', { kind: params.kind, refId: params.refId, notificationId: rowId });
  const result = await sendMail({ ...params.mail, to: recipient });

  await prisma.inquiryNotification.update({
    where: { id: rowId },
    data: {
      status: result.accepted ? 'SENT' : 'FAILED',
      messageId: result.messageId,
      error: result.accepted ? null : result.error,
      sentAt: result.accepted ? new Date() : undefined,
      attempts: { increment: 1 },
    },
  });

  if (!result.accepted && !isTest) {
    logger.warn('owner_mail_failed', { kind: params.kind, refId: params.refId, notificationId: rowId, error: result.error });
  }

  return {
    status: result.accepted ? 'SENT' : 'FAILED',
    notificationId: rowId,
    messageId: result.messageId,
    error: result.error,
  };
}

/**
 * Re-attempts a single PENDING/FAILED owner notification. The original request
 * content is reloaded from its source row so the retry sends the real details.
 * SENT notifications are never re-sent.
 */
export async function retryOwnerInquiryEmail(
  notificationId: string,
): Promise<DeliveryStatus> {
  const row = await prisma.inquiryNotification.findUnique({ where: { id: notificationId } });
  if (!row) throw ApiError.notFound('Notification not found');
  if (row.status === 'SENT') return 'ALREADY_SENT';
  if (!isMailerReady) return 'NOT_CONFIGURED';
  if (!(row.toEmail ?? '').trim()) return 'NO_RECIPIENT';

  const mail = await rebuildOwnerEmail(row.kind, row.refId);
  if (!mail) {
    // The source request no longer exists — nothing truthful to send.
    await prisma.inquiryNotification.update({
      where: { id: notificationId },
      data: { status: 'FAILED', error: 'The original request could not be found.' },
    });
    return 'FAILED';
  }

  const result = await sendMail({ ...mail, to: row.toEmail });
  await prisma.inquiryNotification.update({
    where: { id: notificationId },
    data: {
      status: result.accepted ? 'SENT' : 'FAILED',
      messageId: result.messageId,
      error: result.accepted ? null : result.error,
      sentAt: result.accepted ? new Date() : undefined,
      attempts: { increment: 1 },
    },
  });
  return result.accepted ? 'SENT' : 'FAILED';
}

/** Reloads the original request and rebuilds its owner email, if it still exists. */
async function rebuildOwnerEmail(
  kind: 'CONTACT' | 'PRODUCT' | 'SUPPORT',
  refId: string,
): Promise<MailInput | null> {
  if (kind === 'CONTACT') {
    const row = await prisma.contactInquiry.findUnique({
      where: { id: refId },
      select: {
        name: true,
        email: true,
        businessName: true,
        service: true,
        budgetRange: true,
        message: true,
      },
    });
    if (!row) return null;
    return buildOwnerInquiryEmail({
      kind: 'CONTACT',
      refId,
      heading: 'New contact enquiry',
      name: row.name,
      email: row.email,
      subject: null,
      message: row.message,
      meta: [
        { label: 'Business', value: row.businessName },
        { label: 'Service', value: row.service },
        { label: 'Budget', value: row.budgetRange },
      ],
    });
  }

  if (kind === 'PRODUCT') {
    const row = await prisma.productInquiry.findUnique({
      where: { id: refId },
      select: {
        customerName: true,
        email: true,
        phone: true,
        quantity: true,
        type: true,
        message: true,
        product: { select: { name: true, slug: true } },
      },
    });
    if (!row) return null;
    return buildOwnerInquiryEmail({
      kind: 'PRODUCT',
      refId,
      heading: 'New product enquiry',
      name: row.customerName,
      email: row.email,
      phone: row.phone,
      subject: row.product?.name ? `Product enquiry: ${row.product.name}` : 'Product enquiry',
      message: row.message,
      meta: [
        { label: 'Product', value: row.product?.name },
        { label: 'Type', value: row.type },
        { label: 'Quantity', value: row.quantity != null ? String(row.quantity) : null },
      ],
    });
  }

  const row = await prisma.supportRequest.findUnique({
    where: { id: refId },
    select: { name: true, contact: true, subject: true, message: true },
  });
  if (!row) return null;
  return buildOwnerInquiryEmail({
    kind: 'SUPPORT',
    refId,
    heading: 'New support request',
    name: row.name,
    email: row.contact,
    subject: row.subject,
    message: row.message,
  });
}
