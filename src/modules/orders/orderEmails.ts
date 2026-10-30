import { Prisma } from '@prisma/client';
import { isMailerReady, sendMail } from '../../lib/mailer.js';
import { logger } from '../../lib/logger.js';
import { isTest } from '../../config/env.js';
import { ApiError } from '../../utils/ApiError.js';
import { prisma } from '../../lib/prisma.js';
import {
  detailRow,
  detailTable,
  escapeHtml,
  formatCurrency,
  itemsTable,
  renderLayout,
  type DeliveryStatus,
  type DeliveryOutcome,
  type MailInput,
} from '../shipping/notifications.js';
import { estimatedDeliveryFrom } from './pricing.js';

/**
 * Order-lifecycle emails — cancellation confirmation and return-request
 * notifications. They mirror the shipment-email pattern exactly:
 *
 *   - an outbox row (OrderNotification) is persisted PENDING BEFORE any send,
 *     so a failed delivery can never lose the action;
 *   - delivery state is honest: SENT means the provider ACCEPTED the message,
 *     NOT_CONFIGURED when SMTP is off, FAILED when the provider rejected it;
 *   - a stable idempotencyKey per action guarantees a retried request can never
 *     send a second copy (ALREADY_SENT);
 *   - senders never throw; failures are captured and reported truthfully.
 */

export type OrderEmailType =
  | 'ORDER_CANCELLED'
  | 'RETURN_SUBMITTED'
  | 'RETURN_DECISION'
  | 'ORDER_CONFIRMED';

export interface OrderEmailContext {
  orderNumber: string | null;
  name: string;
  email: string;
  items: Array<{ name: string; qty: number; unitPrice: number; lineTotal: number }>;
  amount: number | string | Prisma.Decimal;
  currency: string;
  /** Pre-delivery subtotal, when available (used to itemise the delivery fee). */
  subtotal?: number | string | Prisma.Decimal | null;
  /** Persisted order timestamp, when available (drives the delivery estimate). */
  createdAt?: Date | string | null;
}

function toOrderContext(order: {
  orderNumber: string | null;
  name: string;
  email: string;
  items: unknown;
  amount: number | string | Prisma.Decimal;
  currency: string | null;
  subtotal?: number | string | Prisma.Decimal | null;
  createdAt?: Date | string | null;
}): OrderEmailContext {
  return {
    orderNumber: order.orderNumber,
    name: order.name,
    email: order.email,
    items: (order.items as OrderEmailContext['items']) ?? [],
    amount: order.amount,
    currency: order.currency ?? 'INR',
    subtotal: order.subtotal ?? null,
    createdAt: order.createdAt ?? null,
  };
}

/* ------------------------------------------------------------------ */
/* Builders                                                            */
/* ------------------------------------------------------------------ */

export function buildCancellationEmail(
  order: OrderEmailContext,
  opts: { refundPending: boolean; refundMessage: string | null },
): MailInput {
  const orderNo = order.orderNumber ?? 'N/A';
  const refundBlock = opts.refundPending
    ? `<p style="margin:12px 0 0;padding:12px 16px;background:#f9fafb;border-left:3px solid #1d4ed8;border-radius:4px;color:#1f2937;">${
        escapeHtml(opts.refundMessage ?? '')
      }</p>`
    : '';

  const body = `<p style="margin:0 0 12px;">Hi ${escapeHtml(order.name)},</p>
<p style="margin:0 0 12px;">Your DRAFTOX order <strong>#${escapeHtml(orderNo)}</strong> was cancelled as you requested.</p>
<p style="margin:0 0 4px;">No further action is needed on your side.</p>
${refundBlock}
<h2 style="margin:20px 0 6px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;font-weight:700;color:#0b1b33;">Items in this order</h2>
${itemsTable(order)}
<p style="margin:20px 0 0;color:#6b7280;font-size:13px;">Did you cancel by mistake? Message us on WhatsApp or reply to this email and we will help.</p>`;

  return {
    to: order.email,
    subject: `Your DRAFTOX order #${orderNo} was cancelled`,
    html: renderLayout(
      `Your DRAFTOX order #${orderNo} was cancelled`,
      `Order #${orderNo} was cancelled`,
      body,
    ),
    text: `Hi ${order.name},

Your DRAFTOX order #${orderNo} was cancelled as you requested. No further action is needed on your side.
${opts.refundPending ? `\n${opts.refundMessage ?? ''}\n` : ''}
Items in this order:
${(order.items ?? [])
  .map((i) => `${i.name} \u00d7${i.qty} \u2014 ${formatCurrency(order.currency, i.lineTotal)}`)
  .join('\n')}

Did you cancel by mistake? Message us on support email and we will help.

- The DRAFTOX team`,
  };
}

export function buildOrderConfirmedEmail(
  order: OrderEmailContext,
  opts: { paymentMethodLabel: string },
): MailInput {
  const orderNo = order.orderNumber ?? 'N/A';
  const amount = Number(order.amount);
  const subtotal = order.subtotal === null || order.subtotal === undefined ? amount : Number(order.subtotal);
  const deliveryFee = Math.max(0, Math.round((amount - subtotal) * 100) / 100);
  const total = formatCurrency(order.currency, amount);
  const subtotalText = formatCurrency(order.currency, subtotal);
  const deliveryText = deliveryFee > 0 ? formatCurrency(order.currency, deliveryFee) : 'Free';
  const estimated = order.createdAt ? estimatedDeliveryFrom(order.createdAt) : null;
  const estimatedText = estimated
    ? estimated.toLocaleDateString('en-IN', { year: 'numeric', month: 'short', day: 'numeric' })
    : null;

  const summary = detailTable([
    detailRow('Subtotal', subtotalText),
    detailRow('Delivery', deliveryText),
    detailRow('Total payable', total),
    ...(estimatedText ? [detailRow('Estimated delivery', estimatedText)] : []),
  ]);

  const body = `<p style="margin:0 0 12px;">Hi ${escapeHtml(order.name)},</p>
<p style="margin:0 0 12px;">Your DRAFTOX order <strong>#${escapeHtml(orderNo)}</strong> is confirmed.</p>
<p style="margin:0 0 12px;">Payment method: <strong>${escapeHtml(opts.paymentMethodLabel)}</strong>. No online payment was taken on the website — please keep ${escapeHtml(total)} ready to pay on delivery.</p>
<h2 style="margin:20px 0 6px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;font-weight:700;color:#0b1b33;">Order summary</h2>
${summary}
<h2 style="margin:20px 0 6px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;font-weight:700;color:#0b1b33;">Items in this order</h2>
${itemsTable(order)}
<p style="margin:20px 0 0;color:#6b7280;font-size:13px;">Our team will contact you about configuration, installation and dispatch. Nothing needs to be paid online. Questions? Message us on WhatsApp or reply to this email.</p>`;

  return {
    to: order.email,
    subject: `Your DRAFTOX order #${orderNo} is confirmed`,
    html: renderLayout(
      `Your DRAFTOX order #${orderNo} is confirmed`,
      `Order #${orderNo} confirmed`,
      body,
    ),
    text: `Hi ${order.name},

Your DRAFTOX order #${orderNo} is confirmed.
Payment method: ${opts.paymentMethodLabel}. No online payment was taken — please keep ${total} ready to pay on delivery.

Order summary:
Subtotal: ${subtotalText}
Delivery: ${deliveryText}
Total payable: ${total}${estimatedText ? `\nEstimated delivery: ${estimatedText}` : ''}

Items in this order:
${(order.items ?? [])
  .map((i) => `${i.name} \u00d7${i.qty} \u2014 ${formatCurrency(order.currency, i.lineTotal)}`)
  .join('\n')}

Our team will contact you about configuration, installation and dispatch.

- The DRAFTOX team`,
  };
}

export function buildReturnSubmittedEmail(
  order: OrderEmailContext,
  input: { reason: string; deadlineHint: string | null; needsReview: boolean },
): MailInput {
  const orderNo = order.orderNumber ?? 'N/A';
  const reviewNote = input.needsReview
    ? '<p style="margin:12px 0 0;color:#6b7280;font-size:13px;">Our team is verifying the delivery date for your return window — you will hear from us shortly.</p>'
    : input.deadlineHint
      ? `<p style="margin:12px 0 0;color:#6b7280;font-size:13px;">${escapeHtml(input.deadlineHint)}</p>`
      : '';

  const body = `<p style="margin:0 0 12px;">Hi ${escapeHtml(order.name)},</p>
<p style="margin:0 0 12px;">We received your return request for DRAFTOX order <strong>#${escapeHtml(orderNo)}</strong>.</p>
<p style="margin:0 0 12px;">Reason: <strong>${escapeHtml(input.reason)}</strong></p>
<p style="margin:0 0 12px;">Our team will review it (including your photos) and get back to you with the next steps. No payment is taken for a return.</p>
${reviewNote}`;

  return {
    to: order.email,
    subject: `Return request received — DRAFTOX order #${orderNo}`,
    html: renderLayout(
      `Return request received for DRAFTOX order #${orderNo}`,
      'Return request received',
      body,
    ),
    text: `Hi ${order.name},

We received your return request for DRAFTOX order #${orderNo}.
Reason: ${input.reason}

Our team will review it (including your photos) and get back to you with the next steps. No payment is taken for a return.
${input.needsReview ? 'We are verifying the delivery date for your return window and will confirm shortly.' : (input.deadlineHint ?? '')}

- The DRAFTOX team`,
  };
}

export function buildReturnDecisionEmail(
  order: OrderEmailContext,
  input: { heading: string; bodyHtml: string; bodyText: string },
): MailInput {
  const orderNo = order.orderNumber ?? 'N/A';
  const body = `<p style="margin:0 0 12px;">Hi ${escapeHtml(order.name)},</p>
<p style="margin:0 0 12px;">There is an update on your return request for DRAFTOX order <strong>#${escapeHtml(orderNo)}</strong>.</p>
${input.bodyHtml}`;

  return {
    to: order.email,
    subject: `Update on your return request — DRAFTOX order #${orderNo}`,
    html: renderLayout(
      `Update on your return request for DRAFTOX order #${orderNo}`,
      escapeHtml(input.heading),
      body,
    ),
    text: `Hi ${order.name},

There is an update on your return request for DRAFTOX order #${orderNo}.

${input.bodyText}

- The DRAFTOX team`,
  };
}

/* ------------------------------------------------------------------ */
/* Admin / business new-order notification                             */
/* ------------------------------------------------------------------ */

export function buildAdminOrderEmail(
  order: OrderEmailContext & { phone?: string | null; address?: unknown },
  opts: { paymentMethodLabel: string; adminUrl?: string | null },
): MailInput {
  const orderNo = order.orderNumber ?? 'N/A';
  const amount = Number(order.amount);
  const subtotal = order.subtotal === null || order.subtotal === undefined ? amount : Number(order.subtotal);
  const deliveryFee = Math.max(0, Math.round((amount - subtotal) * 100) / 100);
  const total = formatCurrency(order.currency, amount);
  const subtotalText = formatCurrency(order.currency, subtotal);
  const deliveryText = deliveryFee > 0 ? formatCurrency(order.currency, deliveryFee) : 'Free';
  const createdAt = order.createdAt ? new Date(order.createdAt) : new Date();
  const dateText = createdAt.toLocaleString('en-IN', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  const addr = order.address as { line?: string; city?: string; state?: string; pincode?: string } | null | undefined;
  const addressText = addr
    ? [addr.line, addr.city, addr.state, addr.pincode].filter(Boolean).join(', ')
    : '—';

  const details = detailTable([
    detailRow('Order number', `#${orderNo}`),
    detailRow('Order date', dateText),
    detailRow('Customer', order.name),
    detailRow('Email', order.email),
    ...(order.phone ? [detailRow('Phone', order.phone)] : []),
    detailRow('Delivery address', addressText),
    detailRow('Payment method', opts.paymentMethodLabel),
    detailRow('Order status', 'CONFIRMED (Cash on Delivery)'),
    detailRow('Subtotal', subtotalText),
    detailRow('Delivery', deliveryText),
    detailRow('Total payable', total),
  ]);

  const adminLink = opts.adminUrl
    ? `<p style="margin:16px 0 0;"><a href="${escapeHtml(opts.adminUrl)}" style="color:#1d4ed8;text-decoration:underline;font-weight:600;">Open order in admin panel &rarr;</a></p>`
    : '';

  const body = `<p style="margin:0 0 12px;font-weight:700;">A new DRAFTOX order has been placed.</p>
<h2 style="margin:16px 0 6px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;font-weight:700;color:#0b1b33;">Order details</h2>
${details}
<h2 style="margin:20px 0 6px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;font-weight:700;color:#0b1b33;">Items ordered</h2>
${itemsTable(order)}
${adminLink}
<p style="margin:20px 0 0;color:#6b7280;font-size:13px;">This is an automated notification. No online payment was taken — the customer will pay on delivery.</p>`;

  return {
    to: '', // will be set by caller
    subject: `New DRAFTOX Order — #${orderNo}`,
    html: renderLayout(
      `New DRAFTOX order #${orderNo}`,
      `New order #${orderNo}`,
      body,
    ),
    text: `A new DRAFTOX order has been placed.

Order number: #${orderNo}
Order date: ${dateText}
Customer: ${order.name}
Email: ${order.email}
${order.phone ? `Phone: ${order.phone}\n` : ''}Delivery address: ${addressText}
Payment method: ${opts.paymentMethodLabel}
Order status: CONFIRMED (Cash on Delivery)
Subtotal: ${subtotalText}
Delivery: ${deliveryText}
Total payable: ${total}

Items ordered:
${(order.items ?? []).map((i) => `${i.name} ×${i.qty} — ${formatCurrency(order.currency, i.lineTotal)}`).join('\n')}

${opts.adminUrl ? `Open order in admin panel: ${opts.adminUrl}\n` : ''}
This is an automated notification. No online payment was taken — the customer will pay on delivery.

- The DRAFTOX team`,
  };
}

/* ------------------------------------------------------------------ */
/* Outbox send + retry                                                  */
/* ------------------------------------------------------------------ */

export interface SendOrderEmailParams {
  orderId: string;
  type: OrderEmailType;
  toEmail: string;
  mail: MailInput;
  /** Stable per-action key so a retried request can never duplicate the email. */
  idempotencyKey: string;
  returnRequestId?: string | null;
}

export async function sendOrderEmail(
  params: SendOrderEmailParams,
): Promise<DeliveryOutcome> {
  const provider = isMailerReady ? 'smtp' : null;
  const recipient = (params.toEmail ?? '').trim();

  let rowId: string;
  const existing = await prisma.orderNotification.findUnique({
    where: { idempotencyKey: params.idempotencyKey },
    select: { id: true, status: true },
  });
  if (existing) {
    if (existing.status === 'SENT') {
      return { status: 'ALREADY_SENT', notificationId: existing.id, messageId: null, error: null };
    }
    rowId = existing.id;
  } else {
    const created = await prisma.orderNotification.create({
      data: {
        orderId: params.orderId,
        returnRequestId: params.returnRequestId ?? null,
        type: params.type,
        status: 'PENDING',
        toEmail: recipient,
        subject: params.mail.subject.slice(0, 200),
        provider,
        idempotencyKey: params.idempotencyKey,
      },
      select: { id: true },
    });
    rowId = created.id;
  }

  if (!recipient) {
    await prisma.orderNotification.update({
      where: { id: rowId },
      data: { status: 'FAILED', error: 'The order has no customer email address.' },
    });
    return {
      status: 'NO_RECIPIENT',
      notificationId: rowId,
      messageId: null,
      error: 'The order has no customer email address.',
    };
  }

  if (!isMailerReady) {
    logger.warn('order_mail_skipped_provider_not_configured', {
      orderId: params.orderId,
      notificationId: rowId,
    });
    return {
      status: 'NOT_CONFIGURED',
      notificationId: rowId,
      messageId: null,
      error: 'Email delivery is not configured on the server.',
    };
  }

  logger.info('order_mail_send', {
    orderId: params.orderId,
    notificationId: rowId,
    type: params.type,
  });
  const result = await sendMail({ ...params.mail, to: recipient });

  await prisma.orderNotification.update({
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
    logger.warn('order_mail_failed', { orderId: params.orderId, notificationId: rowId, error: result.error });
  }

  return {
    status: result.accepted ? 'SENT' : 'FAILED',
    notificationId: rowId,
    messageId: result.messageId,
    error: result.error,
  };
}

/** Re-attempts a single PENDING/FAILED order notification; SENT is never re-sent. */
export async function retryOrderNotification(
  notificationId: string,
): Promise<DeliveryStatus> {
  const row = await prisma.orderNotification.findUnique({
    where: { id: notificationId },
    include: { order: { select: { email: true, name: true, items: true, amount: true, currency: true, orderNumber: true } } },
  });
  if (!row) {
    throw ApiError.notFound('Notification not found');
  }
  if (row.status === 'SENT') return 'ALREADY_SENT';
  if (!isMailerReady) return 'NOT_CONFIGURED';

  const recipient = (row.toEmail ?? row.order.email ?? '').trim();
  if (!recipient) return 'NO_RECIPIENT';

  const ctx = toOrderContext(row.order);
  const mail: MailInput = { to: recipient, subject: row.subject, html: '', text: '' };

  // Reproduction is content-dependent; the safest retry is a terse,
  // accurate follow-up rather than re-inventing the original body.
  const orderNo = ctx.orderNumber ?? 'N/A';
  const heading =
    row.type === 'ORDER_CANCELLED'
      ? `Your DRAFTOX order #${orderNo} was cancelled`
      : row.type === 'RETURN_SUBMITTED'
        ? 'Return request received'
        : row.type === 'ORDER_CONFIRMED'
          ? `Your DRAFTOX order #${orderNo} is confirmed`
          : 'Update on your return request';
  mail.subject = heading;
  mail.html = renderLayout(heading, heading, `<p style="margin:0;">Please contact us on WhatsApp or reply to this email if you need help with your DRAFTOX order <strong>#${escapeHtml(orderNo)}</strong>.</p>`);
  mail.text = `${heading}\n\nPlease contact us on WhatsApp or reply to this email if you need help with your DRAFTOX order #${orderNo}.\n\n- The DRAFTOX team`;

  const result = await sendMail(mail);
  await prisma.orderNotification.update({
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

export { toOrderContext, detailRow, detailTable };