import type { Request, Response } from 'express';
import { prisma } from '../../lib/prisma.js';
import { ApiError } from '../../utils/ApiError.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { normalizeEmail } from '../../utils/normalize.js';
import { supportSchema } from '../../schemas/support.schema.js';
import {
  buildOwnerInquiryEmail,
  sendOwnerInquiryEmail,
} from '../notifications/ownerNotifications.js';

export const createSupportRequest = asyncHandler(async (req: Request, res: Response) => {
  const input = supportSchema.parse(req.body);

  const contactLooksLikeEmail = input.contact.includes('@');
  const contact = contactLooksLikeEmail ? normalizeEmail(input.contact) : input.contact;

  // The request is persisted first, then the owner notification is attempted
  // AFTER commit and outside any transaction, so a slow SMTP round-trip can
  // never roll back the customer's submission.
  const request = await prisma.$transaction(async (tx) => {
    const created = await tx.supportRequest.create({
      data: {
        userId: req.user?.id ?? null,
        name: input.name,
        contact,
        subject: input.subject,
        message: input.message,
        status: 'NEW',
      },
      select: {
        id: true,
        subject: true,
        status: true,
        createdAt: true,
      },
    });

    return created;
  });

  const notification = await sendOwnerInquiryEmail({
    kind: 'SUPPORT',
    refId: request.id,
    idempotencyKey: `support:${request.id}`,
    mail: buildOwnerInquiryEmail({
      kind: 'SUPPORT',
      refId: request.id,
      heading: 'New support request',
      name: input.name,
      email: contactLooksLikeEmail ? contact : '',
      subject: input.subject,
      message: input.message,
      meta: contactLooksLikeEmail ? [] : [{ label: 'Contact', value: contact }],
    }),
  });

  res.status(201).json({
    success: true,
    data: {
      request,
      // Honest owner-notification outcome — `sent` only when the provider accepted it.
      ownerNotification: { status: notification.status, sent: notification.status === 'SENT' },
      message: 'Support request received. Our team will respond as soon as possible.',
    },
  });
});

/** The signed-in user's own support requests. */
export const listSupportRequests = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const requests = await prisma.supportRequest.findMany({
    where: { userId: req.user.id },
    select: {
      id: true,
      subject: true,
      message: true,
      status: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  res.status(200).json({ success: true, data: { requests } });
});
