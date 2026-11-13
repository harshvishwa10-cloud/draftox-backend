import { Prisma } from '@prisma/client';
import { isMailerReady, sendMail } from '../../lib/mailer.js';
import { logger } from '../../lib/logger.js';
import {
  isTest,
  publicSiteUrl,
  brevoConfigured,
  ownerNotificationEmail,
  supportEmail,
} from '../../config/env.js';
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

/**
 * Human-safe label for an online payment method reported by Razorpay. The raw
 * provider value (e.g. `upi`) is normalised for display; unknown methods still
 * render sensibly instead of being dropped.
 */
export function onlinePaymentMethodLabel(method: string | null | undefined): string {
  const value = (method ?? '').trim().toLowerCase();
  switch (value) {
    case 'upi':
      return 'UPI (paid online)';
    case 'card':
      return 'Card (paid online)';
    case 'netbanking':
      return 'Netbanking (paid online)';
    case 'wallet':
      return 'Wallet (paid online)';
    case 'emi':
      return 'EMI (paid online)';
    case 'paylater':
      return 'Pay Later (paid online)';
    default:
      return 'Online payment (paid online)';
  }
}

export function buildAdminOrderEmail(
  order: OrderEmailContext & { phone?: string | null; address?: unknown },
  opts: {
    paymentMethodLabel: string;
    adminUrl?: string | null;
    /** Order status shown to the store team (defaults to the COD wording). */
    statusLabel?: string;
    /** Closing note (defaults to the COD "pay on delivery" wording). */
    note?: string;
  },
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
  const statusLabel = opts.statusLabel ?? 'CONFIRMED (Cash on Delivery)';
  const note =
    opts.note ??
    'This is an automated notification. No online payment was taken — the customer will pay on delivery.';

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
    detailRow('Order status', statusLabel),
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
<p style="margin:20px 0 0;color:#6b7280;font-size:13px;">${escapeHtml(note)}</p>`;

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
Order status: ${statusLabel}
Subtotal: ${subtotalText}
Delivery: ${deliveryText}
Total payable: ${total}

Items ordered:
${(order.items ?? []).map((i) => `${i.name} ×${i.qty} — ${formatCurrency(order.currency, i.lineTotal)}`).join('\n')}

${opts.adminUrl ? `Open order in admin panel: ${opts.adminUrl}\n` : ''}${note}

- The DRAFTOX team`,
  };
}

/* ------------------------------------------------------------------ */
/* Paid online-order notification (after verified payment)             */
/* ------------------------------------------------------------------ */

/**
 * Masks the local part of a recipient for logs (PII minimisation). Kept local
 * so this module only depends on the mailer's send primitives — test doubles
 * that mock `sendMail`/`isMailerReady` need no extra exports.
 */
function maskRecipient(address: string): string {
  const at = address.indexOf('@');
  if (at <= 0) return '***';
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  return `${local.slice(0, 2)}${'*'.repeat(Math.max(1, local.length - 2))}@${domain}`;
}

export interface PaidOrderNotificationResult {
  recipient: string;
  status: DeliveryStatus;
  notificationId: string | null;
  error: string | null;
}

/**
 * Sends the store-owner (and business) new-order email for an order whose
 * ONLINE payment has been verified. This is the online counterpart to the COD
 * block in `createOrder`: it is called only after `markOrderPaid` (or an
 * already-PAID transition) and never before, so a pending/failed payment can
 * never produce a "new paid order" email.
 *
 * Best-effort and idempotent: the caller's order/payment result is never
 * affected, each recipient has its own stable `admin-paid` / `business-paid`
 * key, and a retried webhook or verification can never send a second copy.
 * The recipient is always resolved from trusted server-side config.
 */
export async function dispatchPaidOrderNotifications(
  orderId: string,
): Promise<PaidOrderNotificationResult[]> {
  try {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        orderNumber: true,
        email: true,
        name: true,
        phone: true,
        items: true,
        subtotal: true,
        amount: true,
        currency: true,
        address: true,
        createdAt: true,
        paymentMethod: true,
        status: true,
      },
    });
    if (!order) return [];
    // Defensive: only a genuinely PAID order may trigger a paid-order email.
    if (order.status !== 'PAID') return [];

    const customerEmail = (order.email ?? '').trim().toLowerCase();
    const paymentMethodLabel = onlinePaymentMethodLabel(order.paymentMethod);
    const mail = buildAdminOrderEmail(
      { ...toOrderContext(order), phone: order.phone, address: order.address },
      {
        paymentMethodLabel,
        adminUrl: `${publicSiteUrl}/admin/orders/${order.id}`,
        statusLabel: 'PAID (online payment verified)',
        note: `This is an automated notification. Payment of ${formatCurrency(
          order.currency ?? 'INR',
          Number(order.amount),
        )} was verified online via Razorpay (${paymentMethodLabel}).`,
      },
    );

    const targets: Array<{ recipient: string; keyPrefix: string }> = [];
    const adminRecipient = ownerNotificationEmail?.trim();
    if (adminRecipient) targets.push({ recipient: adminRecipient, keyPrefix: 'admin-paid' });
    const businessRecipient = supportEmail?.trim();
    if (businessRecipient) targets.push({ recipient: businessRecipient, keyPrefix: 'business-paid' });

    const unique = targets.filter(
      (target, index) =>
        target.recipient.toLowerCase() !== customerEmail &&
        targets.findIndex((t) => t.recipient.toLowerCase() === target.recipient.toLowerCase()) === index,
    );

    if (unique.length === 0) {
      logger.warn('paid_order_notification_skipped_no_recipient', { orderId: order.id });
      return [];
    }

    const settled = await Promise.allSettled(
      unique.map(async ({ recipient, keyPrefix }) => {
        const outcome = await sendOrderEmail({
          orderId: order.id,
          type: 'ORDER_CONFIRMED',
          toEmail: recipient,
          mail,
          idempotencyKey: `${keyPrefix}:${order.id}:${recipient}`,
        });
        return {
          recipient,
          status: outcome.status,
          notificationId: outcome.notificationId,
          error: outcome.error,
        } satisfies PaidOrderNotificationResult;
      }),
    );

    const results: PaidOrderNotificationResult[] = settled.map((entry, index) => {
      if (entry.status === 'fulfilled') return entry.value;
      const target = unique[index];
      const message = entry.reason instanceof Error ? entry.reason.message : String(entry.reason);
      logger.warn('paid_order_notification_failed', {
        orderId: order.id,
        recipient: maskRecipient(target.recipient),
        error: message,
      });
      return {
        recipient: target.recipient,
        status: 'FAILED',
        notificationId: null,
        error: message,
      };
    });

    logger.info('paid_order_notification_dispatched', {
      orderId: order.id,
      orderNumber: order.orderNumber,
      results: results.map((r) => ({ recipient: maskRecipient(r.recipient), status: r.status })),
    });
    return results;
  } catch (error) {
    // Never let an email problem fail a verified payment/webhook transition.
    logger.warn('paid_order_notification_failed', {
      orderId,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/**
 * In-flight dedupe for paid-order notifications. Verification, the webhook and
 * the reconciliation job can all observe the same payment within a moment of
 * each other; sharing one promise means they join a single dispatch instead of
 * racing each other (and the outbox) for the same recipients.
 */
const paidOrderDispatchInFlight = new Map<string, Promise<PaidOrderNotificationResult[]>>();

/**
 * Public entry point used by the payment paths. Concurrent calls for the same
 * order share the in-flight dispatch; once it settles, the entry is removed so
 * a later retry (e.g. after an email outage) can try again. The stable outbox
 * idempotency keys still guarantee a SENT notification is never repeated.
 */
export async function notifyPaidOrder(orderId: string): Promise<PaidOrderNotificationResult[]> {
  const inFlight = paidOrderDispatchInFlight.get(orderId);
  if (inFlight) return inFlight;

  const pending = dispatchPaidOrderNotifications(orderId);
  paidOrderDispatchInFlight.set(orderId, pending);
  try {
    return await pending;
  } finally {
    // Only clear our own entry: a newer dispatch must not be evicted here.
    if (paidOrderDispatchInFlight.get(orderId) === pending) {
      paidOrderDispatchInFlight.delete(orderId);
    }
  }
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
  // Record the transport that actually handled the message: Brevo's HTTP API
  // takes precedence in sendMail() whenever BREVO_API_KEY is present.
  const provider = isMailerReady ? (brevoConfigured ? 'brevo' : 'smtp') : null;
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
    try {
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
    } catch (err) {
      // A concurrent replay (e.g. Razorpay retrying the same webhook) may have
      // created this exact idempotency key first. Reuse its row instead of
      // failing, and never send a second copy if it was already accepted.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const raced = await prisma.orderNotification.findUnique({
          where: { idempotencyKey: params.idempotencyKey },
          select: { id: true, status: true },
        });
        if (!raced) throw err;
        if (raced.status === 'SENT') {
          return { status: 'ALREADY_SENT', notificationId: raced.id, messageId: null, error: null };
        }
        rowId = raced.id;
      } else {
        throw err;
      }
    }
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
    const notConfigured = 'Email delivery is not configured on the server.';
    logger.warn('order_mail_skipped_provider_not_configured', {
      orderId: params.orderId,
      notificationId: rowId,
    });
    // Persist the honest, retryable state. Leaving the row PENDING would imply
    // a send is still in flight and make the missing delivery invisible to the
    // admin retry tooling once SMTP is configured again.
    await prisma.orderNotification.update({
      where: { id: rowId },
      data: { status: 'FAILED', error: notConfigured },
    });
    return {
      status: 'NOT_CONFIGURED',
      notificationId: rowId,
      messageId: null,
      error: notConfigured,
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
    include: {
      order: {
        select: {
          email: true,
          name: true,
          items: true,
          amount: true,
          currency: true,
          orderNumber: true,
          subtotal: true,
          createdAt: true,
          phone: true,
          address: true,
          status: true,
          paymentMethod: true,
        },
      },
    },
  });
  if (!row) {
    throw ApiError.notFound('Notification not found');
  }
  if (row.status === 'SENT') return 'ALREADY_SENT';
  if (!isMailerReady) return 'NOT_CONFIGURED';

  const recipient = (row.toEmail ?? row.order.email ?? '').trim();
  if (!recipient) return 'NO_RECIPIENT';

  const ctx = toOrderContext(row.order);
  const orderNo = ctx.orderNumber ?? 'N/A';

  /*
   * Admin/business notifications share the ORDER_CONFIRMED type but are
   * addressed to an internal inbox rather than the customer. A retry for one of
   * those must reproduce the internal new-order email — never the customer
   * confirmation body (wrong audience, wrong content).
   */
  const isInternalRecipient =
    row.type === 'ORDER_CONFIRMED' &&
    recipient.toLowerCase() !== (row.order.email ?? '').trim().toLowerCase();

  let mail: MailInput;
  if (isInternalRecipient) {
    const isPaid = row.order.status === 'PAID';
    const paymentMethodLabel = isPaid
      ? onlinePaymentMethodLabel(row.order.paymentMethod)
      : 'Cash on Delivery';
    mail = buildAdminOrderEmail(
      { ...ctx, phone: row.order.phone, address: row.order.address },
      {
        paymentMethodLabel,
        adminUrl: `${publicSiteUrl}/admin/orders/${row.orderId}`,
        ...(isPaid
          ? {
              statusLabel: 'PAID (online payment verified)',
              note: `This is an automated notification. Payment of ${formatCurrency(
                ctx.currency,
                Number(ctx.amount),
              )} was verified online via Razorpay (${paymentMethodLabel}).`,
            }
          : {}),
      },
    );
    mail.to = recipient;
  } else {
    // Reproduction is content-dependent; the safest retry is a terse,
    // accurate follow-up rather than re-inventing the original body.
    const heading =
      row.type === 'ORDER_CANCELLED'
        ? `Your DRAFTOX order #${orderNo} was cancelled`
        : row.type === 'RETURN_SUBMITTED'
          ? 'Return request received'
          : row.type === 'ORDER_CONFIRMED'
            ? `Your DRAFTOX order #${orderNo} is confirmed`
            : 'Update on your return request';
    mail = {
      to: recipient,
      subject: heading,
      html: renderLayout(heading, heading, `<p style="margin:0;">Please contact us on WhatsApp or reply to this email if you need help with your DRAFTOX order <strong>#${escapeHtml(orderNo)}</strong>.</p>`),
      text: `${heading}\n\nPlease contact us on WhatsApp or reply to this email if you need help with your DRAFTOX order #${orderNo}.\n\n- The DRAFTOX team`,
    };
  }

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