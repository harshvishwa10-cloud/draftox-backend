import { randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { sendMail, isMailerReady } from '../../lib/mailer.js';
import { publicSiteUrl, supportEmail, isTest } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { ApiError } from '../../utils/ApiError.js';
import { prisma } from '../../lib/prisma.js';

/** Generates an opaque, high-entropy tracking token (32 URL-safe chars). */
export function generateTrackingToken(): string {
  return randomBytes(24).toString('base64url');
}

/** Builds the public tracking page URL for a token. */
export function trackingPageUrl(token: string): string {
  return `${publicSiteUrl}/track/${encodeURIComponent(token)}`;
}

export interface ShipmentDetails {
  courierName: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  dispatchNotes: string | null;
  dispatchedAt: Date | null;
  estimatedDeliveryAt: Date | null;
}

export interface OrderInfo {
  orderNumber: string | null;
  email: string;
  name: string;
  address: { line: string; city: string; state: string; pincode: string } | null;
  items: Array<{ name: string; qty: number; unitPrice: number; lineTotal: number }>;
  amount: number | string | Prisma.Decimal;
  currency: string;
}

interface MailInput {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export type { MailInput };

interface SendResult {
  accepted: boolean;
  messageId: string | null;
  error: string | null;
}

/**
 * Truthful outcome of a shipment-email delivery attempt.
 *
 * `SENT` means the email provider ACCEPTED the message for delivery — NOT that
 * it reached the customer's inbox. Every other status is kept distinct so the
 * admin UI can report exactly what happened instead of a blanket "sent".
 */
export type DeliveryStatus =
  | 'SENT'
  | 'FAILED'
  | 'NOT_CONFIGURED'
  | 'NO_RECIPIENT'
  | 'ALREADY_SENT';

export interface DeliveryOutcome {
  status: DeliveryStatus;
  notificationId: string | null;
  messageId: string | null;
  error: string | null;
}

/* ------------------------------------------------------------------ */
/* Formatting helpers                                                  */
/* ------------------------------------------------------------------ */

const BRAND = '#0b1b33';
const ACCENT = '#1d4ed8';
const TEXT = '#1f2937';
const MUTED = '#6b7280';
const BORDER = '#e5e7eb';
const FONT =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

function formatCurrency(currency: string, value: number | string | Prisma.Decimal): string {
  const n = typeof value === 'number' ? value : Number(value);
  const sym = currency === 'INR' ? '\u20B9' : currency;
  return Number.isFinite(n) ? `${sym}${n.toFixed(2)}` : '\u2014';
}

export { formatCurrency };

function formatDate(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  const date = typeof d === 'string' ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString('en-IN', { year: 'numeric', month: 'short', day: 'numeric' });
}

function escapeHtml(value: string | null | undefined): string {
  if (!value) return '';
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export { escapeHtml };

/** Plain-text item list (used for the email's text/plain alternative). */
function formatItemsText(order: OrderInfo): string {
  const items = order.items ?? [];
  if (items.length === 0) return '\u2014';
  return items
    .map((i) => `${i.name} \u00d7${i.qty} \u2014 ${formatCurrency(order.currency, i.lineTotal)}`)
    .join('\n');
}

/* ------------------------------------------------------------------ */
/* HTML building blocks                                                */
/* ------------------------------------------------------------------ */

/** Responsive, table-based HTML shell with DRAFTOX branding + support footer. */
export function renderLayout(preheader: string, heading: string, bodyHtml: string): string {
  const year = new Date().getFullYear();
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light">
<title>DRAFTOX</title>
</head>
<body style="margin:0;padding:0;background:#f3f4f6;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#ffffff;border:1px solid ${BORDER};border-radius:12px;overflow:hidden;">
<tr><td style="background:${BRAND};padding:20px 28px;">
<span style="font-family:${FONT};font-size:22px;font-weight:800;letter-spacing:3px;color:#ffffff;">DRAFTOX</span>
</td></tr>
<tr><td style="padding:28px;font-family:${FONT};font-size:15px;line-height:1.6;color:${TEXT};">
<h1 style="margin:0 0 16px;font-family:${FONT};font-size:20px;line-height:1.3;font-weight:700;color:${BRAND};">${escapeHtml(heading)}</h1>
${bodyHtml}
</td></tr>
<tr><td style="padding:18px 28px;background:#f9fafb;border-top:1px solid ${BORDER};font-family:${FONT};font-size:12px;line-height:1.6;color:${MUTED};">
<p style="margin:0 0 6px;">Need help? Contact us at <a href="mailto:${escapeHtml(supportEmail)}" style="color:${ACCENT};text-decoration:underline;">${escapeHtml(supportEmail)}</a>.</p>
<p style="margin:0;">&copy; ${year} DRAFTOX. This is an automated message about your order.</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

function trackingButton(url: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:16px 0 8px;">
<tr><td style="border-radius:8px;background:${ACCENT};">
<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:12px 24px;font-family:${FONT};font-size:14px;font-weight:700;color:#ffffff;text-decoration:none;">Track your order</a>
</td></tr>
</table>`;
}

function detailRow(label: string, value: string): string {
  return `<tr>
<td style="padding:4px 8px 4px 0;font-family:${FONT};font-size:14px;color:${MUTED};width:150px;vertical-align:top;">${escapeHtml(label)}</td>
<td style="padding:4px 0;font-family:${FONT};font-size:14px;color:${TEXT};font-weight:600;vertical-align:top;">${escapeHtml(value)}</td>
</tr>`;
}

export { detailRow };

function detailTable(rows: string[]): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 4px;">${rows.join('')}</table>`;
}

export { detailTable };

function itemsTable(order: Pick<OrderInfo, 'items' | 'currency'>): string {
  const items = order.items ?? [];
  if (items.length === 0) {
    return `<p style="margin:0;color:${MUTED};">Your items are listed in the order confirmation.</p>`;
  }
  const rows = items
    .map(
      (i) => `<tr>
<td style="padding:8px 0;border-bottom:1px solid #f1f5f9;font-family:${FONT};font-size:14px;color:${TEXT};">${escapeHtml(i.name)}<br><span style="color:${MUTED};font-size:12px;">Qty ${i.qty}</span></td>
<td align="right" style="padding:8px 0;border-bottom:1px solid #f1f5f9;font-family:${FONT};font-size:14px;color:${TEXT};white-space:nowrap;">${escapeHtml(formatCurrency(order.currency, i.lineTotal))}</td>
</tr>`,
    )
    .join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>`;
}

export { itemsTable };

/**
 * Renders the INITIAL shipment email (sent once, automatically, when the first
 * shipment details are saved for a paid order).
 */
export function buildInitialEmail(
  order: OrderInfo,
  shipment: ShipmentDetails,
  token: string,
): MailInput {
  const trackingLink = trackingPageUrl(token);
  const orderNo = order.orderNumber ?? 'N/A';
  const courier = shipment.courierName ?? 'to be confirmed';
  const awb = shipment.trackingNumber ?? 'to be confirmed';
  const est = formatDate(shipment.estimatedDeliveryAt);

  const details = detailTable([
    detailRow('Courier', courier),
    detailRow('Tracking number', awb),
    ...(est ? [detailRow('Estimated delivery', est)] : []),
  ]);

  const courierLink = shipment.trackingUrl
    ? `<p style="margin:8px 0 0;color:${MUTED};font-size:13px;">You can also follow it on the <a href="${escapeHtml(shipment.trackingUrl)}" target="_blank" rel="noopener noreferrer" style="color:${ACCENT};">courier&rsquo;s website</a>.</p>`
    : '';

  const body = `<p style="margin:0 0 12px;">Hi ${escapeHtml(order.name)},</p>
<p style="margin:0 0 12px;">Good news &mdash; your DRAFTOX order <strong>#${escapeHtml(orderNo)}</strong> is on its way.</p>
<h2 style="margin:16px 0 6px;font-family:${FONT};font-size:15px;font-weight:700;color:${BRAND};">Package details</h2>
${details}
${trackingButton(trackingLink)}
${courierLink}
<h2 style="margin:20px 0 6px;font-family:${FONT};font-size:15px;font-weight:700;color:${BRAND};">Items in this shipment</h2>
${itemsTable(order)}
<p style="margin:20px 0 0;color:${MUTED};font-size:13px;">Thank you for shopping with DRAFTOX.</p>`;

  return {
    to: order.email,
    subject: `Your DRAFTOX order #${orderNo} has shipped`,
    html: renderLayout(`Your DRAFTOX order #${orderNo} has shipped`, `Order #${orderNo} has shipped`, body),
    text: `Hi ${order.name},

Good news - your DRAFTOX order #${orderNo} is on its way.

Package details
Courier: ${courier}
Tracking number: ${awb}
${est ? `Estimated delivery: ${est}\n` : ''}
Track your order: ${trackingLink}
${shipment.trackingUrl ? `Courier tracking: ${shipment.trackingUrl}\n` : ''}
Items in this shipment:
${formatItemsText(order)}

Need help? Email us at ${supportEmail}.

- The DRAFTOX team`,
  };
}

/**
 * Renders the UPDATE email (sent only when an admin explicitly triggers it).
 */
export function buildUpdateEmail(
  order: OrderInfo,
  shipment: ShipmentDetails,
  token: string,
  note: string | null,
): MailInput {
  const trackingLink = trackingPageUrl(token);
  const orderNo = order.orderNumber ?? 'N/A';
  const dispatched = formatDate(shipment.dispatchedAt);
  const est = formatDate(shipment.estimatedDeliveryAt);

  const details = detailTable([
    detailRow('Courier', shipment.courierName ?? 'N/A'),
    detailRow('Tracking number', shipment.trackingNumber ?? 'N/A'),
    ...(dispatched ? [detailRow('Dispatched', dispatched)] : []),
    ...(est ? [detailRow('Estimated delivery', est)] : []),
  ]);

  const body = `<p style="margin:0 0 12px;">Hi ${escapeHtml(order.name)},</p>
<p style="margin:0 0 12px;">There is an update on your DRAFTOX order <strong>#${escapeHtml(orderNo)}</strong>.</p>
${note ? `<p style="margin:12px 0;padding:12px 16px;background:#f9fafb;border-left:3px solid ${ACCENT};border-radius:4px;color:${TEXT};">${escapeHtml(note)}</p>` : ''}
<h2 style="margin:16px 0 6px;font-family:${FONT};font-size:15px;font-weight:700;color:${BRAND};">Latest tracking details</h2>
${details}
${trackingButton(trackingLink)}
<h2 style="margin:20px 0 6px;font-family:${FONT};font-size:15px;font-weight:700;color:${BRAND};">Your items</h2>
${itemsTable(order)}
<p style="margin:20px 0 0;color:${MUTED};font-size:13px;">Thank you for shopping with DRAFTOX.</p>`;

  return {
    to: order.email,
    subject: `Update on your DRAFTOX order #${orderNo}`,
    html: renderLayout(`Update on DRAFTOX order #${orderNo}`, `Update on order #${orderNo}`, body),
    text: `Hi ${order.name},

There is an update on your DRAFTOX order #${orderNo}.
${note ? `\n${note}\n` : ''}
Latest tracking details
Courier: ${shipment.courierName ?? 'N/A'}
Tracking number: ${shipment.trackingNumber ?? 'N/A'}
${dispatched ? `Dispatched: ${dispatched}\n` : ''}
${est ? `Estimated delivery: ${est}\n` : ''}
Track your order: ${trackingLink}

Your items:
${formatItemsText(order)}

Need help? Email us at ${supportEmail}.

- The DRAFTOX team`,
  };
}

async function doSend(email: MailInput): Promise<SendResult> {
  const result = await sendMail(email);
  return {
    accepted: result.accepted,
    messageId: result.messageId,
    error: result.error,
  };
}

function isPrismaUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

/**
 * Called from upsertOrderShipment when a shipment is first saved with a
 * tracking token. Idempotent: the database-level unique partial index on
 * (orderId, INITIAL) guarantees at most one INITIAL row per order even under
 * concurrent requests.
 *
 * The returned status is truthful: `SENT` only when the provider ACCEPTED the
 * message, `ALREADY_SENT` when an earlier INITIAL was already accepted,
 * `NO_RECIPIENT`/`NOT_CONFIGURED` when no send was attempted, and `FAILED` when
 * the provider rejected or errored.
 */
export async function sendInitialShipmentEmail(
  orderId: string,
  order: OrderInfo,
  shipment: ShipmentDetails,
  token: string,
): Promise<DeliveryOutcome> {
  const existing = await prisma.shipmentNotification.findFirst({
    where: { orderId, type: 'INITIAL' },
    select: { id: true, status: true },
  });

  if (existing && existing.status === 'SENT') {
    return { status: 'ALREADY_SENT', notificationId: existing.id, messageId: null, error: null };
  }

  const provider = isMailerReady ? 'smtp' : null;
  let notificationId: string;
  let isNew = false;

  try {
    if (existing) {
      notificationId = existing.id;
    } else {
      const created = await prisma.shipmentNotification.create({
        data: {
          orderId,
          type: 'INITIAL',
          status: 'PENDING',
          toEmail: order.email,
          provider,
        },
        select: { id: true },
      });
      notificationId = created.id;
      isNew = true;
    }
  } catch (err) {
    // Concurrent request won the race to create the INITIAL row.
    if (isPrismaUniqueViolation(err)) {
      const after = await prisma.shipmentNotification.findFirst({
        where: { orderId, type: 'INITIAL' },
        select: { id: true, status: true },
      });
      if (after?.status === 'SENT') {
        return { status: 'ALREADY_SENT', notificationId: after.id, messageId: null, error: null };
      }
      if (!after?.id) throw err;
      notificationId = after.id;
    } else {
      throw err;
    }
  }

  const recipient = (order.email ?? '').trim();
  if (!recipient) {
    await prisma.shipmentNotification.update({
      where: { id: notificationId },
      data: { status: 'FAILED', error: 'The order has no customer email address.' },
    });
    logger.warn('mail_initial_skipped_no_recipient', { orderId, notificationId });
    return {
      status: 'NO_RECIPIENT',
      notificationId,
      messageId: null,
      error: 'The order has no customer email address.',
    };
  }

  if (!isMailerReady) {
    logger.warn('mail_initial_skipped_provider_not_configured', { orderId, notificationId });
    return {
      status: 'NOT_CONFIGURED',
      notificationId,
      messageId: null,
      error: 'Email delivery is not configured on the server.',
    };
  }

  logger.info('mail_initial_notification_send', { orderId, notificationId, isNew });
  const result = await doSend(buildInitialEmail(order, shipment, token));

  await prisma.shipmentNotification.update({
    where: { id: notificationId },
    data: {
      status: result.accepted ? 'SENT' : 'FAILED',
      messageId: result.messageId,
      error: result.error,
      sentAt: result.accepted ? new Date() : undefined,
      attempts: { increment: 1 },
    },
  });

  if (!result.accepted && !isTest) {
    logger.warn('mail_initial_failed', { orderId, notificationId, error: result.error });
  }

  return {
    status: result.accepted ? 'SENT' : 'FAILED',
    notificationId,
    messageId: result.messageId,
    error: result.error,
  };
}

/**
 * Sends an UPDATE email for an existing shipment. Intended for explicit admin
 * action. When an `idempotencyKey` is supplied, a repeated request with the
 * same key will never send a second copy: it either returns ALREADY_SENT (the
 * earlier message was accepted) or safely retries the earlier failed row.
 */
export async function sendUpdateShipmentEmail(
  orderId: string,
  shipment: ShipmentDetails,
  token: string,
  order: OrderInfo,
  note: string | null,
  shipmentId: string | null,
  idempotencyKey: string | null,
): Promise<DeliveryOutcome> {
  const provider = isMailerReady ? 'smtp' : null;
  let rowId: string;

  if (idempotencyKey) {
    const existing = await prisma.shipmentNotification.findUnique({
      where: { idempotencyKey },
      select: { id: true, status: true },
    });
    if (existing) {
      if (existing.status === 'SENT') {
        return { status: 'ALREADY_SENT', notificationId: existing.id, messageId: null, error: null };
      }
      // Reuse the earlier failed/pending row and retry it (no duplicate row).
      rowId = existing.id;
    } else {
      const created = await prisma.shipmentNotification.create({
        data: {
          orderId,
          shipmentId,
          type: 'UPDATE',
          status: 'PENDING',
          toEmail: order.email,
          provider,
          idempotencyKey,
        },
        select: { id: true },
      });
      rowId = created.id;
    }
  } else {
    const created = await prisma.shipmentNotification.create({
      data: {
        orderId,
        shipmentId,
        type: 'UPDATE',
        status: 'PENDING',
        toEmail: order.email,
        provider,
        idempotencyKey: null,
      },
      select: { id: true },
    });
    rowId = created.id;
  }

  const recipient = (order.email ?? '').trim();
  if (!recipient) {
    await prisma.shipmentNotification.update({
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
    logger.warn('mail_update_skipped_provider_not_configured', { orderId, notificationId: rowId });
    return {
      status: 'NOT_CONFIGURED',
      notificationId: rowId,
      messageId: null,
      error: 'Email delivery is not configured on the server.',
    };
  }

  logger.info('mail_update_notification_send', { orderId, notificationId: rowId });
  const result = await doSend(buildUpdateEmail(order, shipment, token, note));

  await prisma.shipmentNotification.update({
    where: { id: rowId },
    data: {
      status: result.accepted ? 'SENT' : 'FAILED',
      messageId: result.messageId,
      error: result.error,
      sentAt: result.accepted ? new Date() : undefined,
      attempts: { increment: 1 },
    },
  });

  return {
    status: result.accepted ? 'SENT' : 'FAILED',
    notificationId: rowId,
    messageId: result.messageId,
    error: result.error,
  };
}

/**
 * Re-attempts a single PENDING or FAILED notification by id. A notification
 * that was already accepted (SENT) is NEVER re-sent — this is the guard against
 * duplicate emails from repeated admin retries. Returns a truthful status.
 */
export async function retryNotification(
  notificationId: string,
): Promise<DeliveryStatus> {
  const row = await prisma.shipmentNotification.findUnique({
    where: { id: notificationId },
    include: { order: true },
  });
  if (!row) {
    throw ApiError.notFound('Notification not found');
  }

  // Duplicate-email guard: never resend an email the provider already accepted.
  if (row.status === 'SENT') {
    return 'ALREADY_SENT';
  }

  if (!isMailerReady) {
    return 'NOT_CONFIGURED';
  }

  const recipient = (row.toEmail ?? row.order.email ?? '').trim();
  if (!recipient) {
    return 'NO_RECIPIENT';
  }

  const shipment = await prisma.shipment.findUnique({
    where: { orderId: row.orderId },
    select: {
      courierName: true,
      trackingNumber: true,
      trackingUrl: true,
      dispatchNotes: true,
      dispatchedAt: true,
      estimatedDeliveryAt: true,
      trackingToken: true,
    },
  });
  if (!shipment?.trackingToken) {
    throw ApiError.notFound('Shipment or tracking token not found');
  }

  const orderInfo: OrderInfo = {
    orderNumber: row.order.orderNumber,
    email: recipient,
    name: row.order.name,
    address: row.order.address as OrderInfo['address'],
    items: row.order.items as OrderInfo['items'],
    amount: row.order.amount,
    currency: row.order.currency ?? 'INR',
  };
  const shipmentDetails: ShipmentDetails = {
    courierName: shipment.courierName,
    trackingNumber: shipment.trackingNumber,
    trackingUrl: shipment.trackingUrl,
    dispatchNotes: shipment.dispatchNotes,
    dispatchedAt: shipment.dispatchedAt,
    estimatedDeliveryAt: shipment.estimatedDeliveryAt,
  };

  const email =
    row.type === 'INITIAL'
      ? buildInitialEmail(orderInfo, shipmentDetails, shipment.trackingToken)
      : buildUpdateEmail(orderInfo, shipmentDetails, shipment.trackingToken, null);

  const result = await doSend(email);
  await prisma.shipmentNotification.update({
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
