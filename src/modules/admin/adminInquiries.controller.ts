import type { Request, Response } from 'express';
import type { InquiryKind, Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { ApiError } from '../../utils/ApiError.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { retryOwnerInquiryEmail } from '../notifications/ownerNotifications.js';

/**
 * Admin "inbox" for public requests (contact enquiries, product enquiries and
 * support requests). Until now these arrived in the database but the owner had
 * no way to see them in the app — this exposes them, read-only plus a status
 * workflow. Every route is gated by requireAuth + requireAdmin in admin.routes.
 */

const LIST_DEFAULT_LIMIT = 20;
const LIST_MAX_LIMIT = 100;

const inquiryStatusValues = ['NEW', 'IN_REVIEW', 'CONTACTED', 'RESOLVED', 'CLOSED'] as const;
const updateInquiryStatusSchema = z.object({ status: z.enum(inquiryStatusValues) }).strict();

const listQuerySchema = z
  .object({
    q: z.string().trim().max(200).optional(),
    status: z.enum(inquiryStatusValues).optional(),
    limit: z.coerce.number().int().min(1).max(LIST_MAX_LIMIT).optional(),
    cursor: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

const notificationSelect = {
  id: true,
  kind: true,
  refId: true,
  toEmail: true,
  subject: true,
  status: true,
  provider: true,
  attempts: true,
  messageId: true,
  error: true,
  sentAt: true,
  createdAt: true,
} as const;

type NotificationRow = {
  id: string;
  refId: string;
} & Record<string, unknown>;

/** Attaches the latest owner-notification row to each listed request. */
async function withOwnerNotifications<T extends { id: string }>(
  kind: InquiryKind,
  rows: T[],
): Promise<Array<T & { ownerNotification: unknown }>> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const notifications = (await prisma.inquiryNotification.findMany({
    where: { kind, refId: { in: ids } },
    orderBy: { createdAt: 'desc' },
    select: notificationSelect,
  })) as NotificationRow[];

  const latest = new Map<string, NotificationRow>();
  for (const n of notifications) {
    if (!latest.has(n.refId)) latest.set(n.refId, n);
  }
  return rows.map((row) => ({ ...row, ownerNotification: latest.get(row.id) ?? null }));
}

function paginate<T extends { id: string }>(rows: T[], limit: number) {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore && items.length > 0 ? items[items.length - 1].id : null;
  return { items, nextCursor };
}

const contactSelect = {
  id: true,
  name: true,
  email: true,
  businessName: true,
  service: true,
  budgetRange: true,
  message: true,
  status: true,
  userId: true,
  createdAt: true,
} as const;

const productSelect = {
  id: true,
  customerName: true,
  email: true,
  phone: true,
  quantity: true,
  type: true,
  message: true,
  status: true,
  userId: true,
  createdAt: true,
  product: { select: { id: true, name: true, slug: true } },
} as const;

const supportSelect = {
  id: true,
  name: true,
  contact: true,
  subject: true,
  message: true,
  status: true,
  userId: true,
  createdAt: true,
} as const;

export const listAdminContactInquiries = asyncHandler(async (req: Request, res: Response) => {
  const query = listQuerySchema.parse(req.query);
  const limit = Math.min(query.limit ?? LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT);

  const where: Prisma.ContactInquiryWhereInput = {};
  if (query.status) where.status = query.status;
  if (query.q) {
    where.OR = [
      { name: { contains: query.q, mode: 'insensitive' } },
      { email: { contains: query.q, mode: 'insensitive' } },
      { businessName: { contains: query.q, mode: 'insensitive' } },
    ];
  }

  const rows = await prisma.contactInquiry.findMany({
    where,
    select: contactSelect,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
  });
  const { items, nextCursor } = paginate(rows, limit);
  res
    .status(200)
    .json({ success: true, data: { inquiries: await withOwnerNotifications('CONTACT', items), nextCursor } });
});

export const listAdminProductInquiries = asyncHandler(async (req: Request, res: Response) => {
  const query = listQuerySchema.parse(req.query);
  const limit = Math.min(query.limit ?? LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT);

  const where: Prisma.ProductInquiryWhereInput = {};
  if (query.status) where.status = query.status;
  if (query.q) {
    where.OR = [
      { customerName: { contains: query.q, mode: 'insensitive' } },
      { email: { contains: query.q, mode: 'insensitive' } },
      { phone: { contains: query.q } },
      { product: { name: { contains: query.q, mode: 'insensitive' } } },
    ];
  }

  const rows = await prisma.productInquiry.findMany({
    where,
    select: productSelect,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
  });
  const { items, nextCursor } = paginate(rows, limit);
  res
    .status(200)
    .json({ success: true, data: { inquiries: await withOwnerNotifications('PRODUCT', items), nextCursor } });
});

export const listAdminSupportRequests = asyncHandler(async (req: Request, res: Response) => {
  const query = listQuerySchema.parse(req.query);
  const limit = Math.min(query.limit ?? LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT);

  const where: Prisma.SupportRequestWhereInput = {};
  if (query.status) where.status = query.status;
  if (query.q) {
    where.OR = [
      { name: { contains: query.q, mode: 'insensitive' } },
      { contact: { contains: query.q, mode: 'insensitive' } },
      { subject: { contains: query.q, mode: 'insensitive' } },
    ];
  }

  const rows = await prisma.supportRequest.findMany({
    where,
    select: supportSelect,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
  });
  const { items, nextCursor } = paginate(rows, limit);
  res
    .status(200)
    .json({ success: true, data: { requests: await withOwnerNotifications('SUPPORT', items), nextCursor } });
});

export const updateContactInquiryStatus = asyncHandler(async (req: Request, res: Response) => {
  const id = String(req.params.id ?? '');
  const { status } = updateInquiryStatusSchema.parse(req.body);
  const existing = await prisma.contactInquiry.findUnique({ where: { id }, select: { id: true } });
  if (!existing) throw ApiError.notFound('Inquiry not found');
  const inquiry = await prisma.contactInquiry.update({
    where: { id },
    data: { status },
    select: contactSelect,
  });
  res.status(200).json({ success: true, data: { inquiry } });
});

export const updateProductInquiryStatus = asyncHandler(async (req: Request, res: Response) => {
  const id = String(req.params.id ?? '');
  const { status } = updateInquiryStatusSchema.parse(req.body);
  const existing = await prisma.productInquiry.findUnique({ where: { id }, select: { id: true } });
  if (!existing) throw ApiError.notFound('Inquiry not found');
  const inquiry = await prisma.productInquiry.update({
    where: { id },
    data: { status },
    select: productSelect,
  });
  res.status(200).json({ success: true, data: { inquiry } });
});

export const updateSupportRequestStatus = asyncHandler(async (req: Request, res: Response) => {
  const id = String(req.params.id ?? '');
  const { status } = updateInquiryStatusSchema.parse(req.body);
  const existing = await prisma.supportRequest.findUnique({ where: { id }, select: { id: true } });
  if (!existing) throw ApiError.notFound('Support request not found');
  const request = await prisma.supportRequest.update({
    where: { id },
    data: { status },
    select: supportSelect,
  });
  res.status(200).json({ success: true, data: { request } });
});

/** Re-attempts a single PENDING/FAILED owner notification for a request. */
export const retryInquiryNotification = asyncHandler(async (req: Request, res: Response) => {
  const notificationId = String(req.params.id ?? '');
  const result = await retryOwnerInquiryEmail(notificationId);

  res.status(200).json({
    success: true,
    data: { notificationId, status: result, sent: result === 'SENT' },
    message:
      result === 'SENT'
        ? 'Notification accepted by the provider after retry.'
        : result === 'ALREADY_SENT'
          ? 'This notification was already accepted by the provider — not sent again.'
          : result === 'NOT_CONFIGURED'
            ? 'Email delivery is not configured. Set EMAIL_PROVIDER=smtp to enable retries.'
            : result === 'NO_RECIPIENT'
              ? 'No owner notification address is configured.'
              : 'The email provider did not accept the message. Please try again later.',
  });
});
