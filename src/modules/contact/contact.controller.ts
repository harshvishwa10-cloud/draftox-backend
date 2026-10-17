import type { Request, Response } from 'express';
import { prisma } from '../../lib/prisma.js';
import { ApiError } from '../../utils/ApiError.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { contactSchema } from '../../schemas/contact.schema.js';
import { normalizeEmail } from '../../utils/normalize.js';
import {
  buildOwnerInquiryEmail,
  sendOwnerInquiryEmail,
} from '../notifications/ownerNotifications.js';

export const createContactInquiry = asyncHandler(async (req: Request, res: Response) => {
  const input = contactSchema.parse(req.body);

  // Status is never accepted from the client — always starts NEW. The inquiry is
  // persisted first, then the owner notification is attempted AFTER commit and
  // outside any transaction, so a slow SMTP round-trip can never roll back the
  // customer's submission.
  const inquiry = await prisma.$transaction(async (tx) => {
    const created = await tx.contactInquiry.create({
      data: {
        // Attach the signed-in user when present; otherwise a guest inquiry.
        userId: req.user?.id ?? null,
        name: input.name,
        email: normalizeEmail(input.email),
        businessName: input.businessName || null,
        service: input.service,
        budgetRange: input.budgetRange ?? null,
        message: input.message,
        status: 'NEW',
      },
      select: {
        id: true,
        status: true,
        createdAt: true,
      },
    });

    return created;
  });

  const notification = await sendOwnerInquiryEmail({
    kind: 'CONTACT',
    refId: inquiry.id,
    idempotencyKey: `contact:${inquiry.id}`,
    mail: buildOwnerInquiryEmail({
      kind: 'CONTACT',
      refId: inquiry.id,
      heading: 'New contact enquiry',
      name: input.name,
      email: normalizeEmail(input.email),
      subject: null,
      message: input.message,
      meta: [
        { label: 'Business', value: input.businessName ?? null },
        { label: 'Service', value: input.service },
        { label: 'Budget', value: input.budgetRange ?? null },
      ],
    }),
  });

  res.status(201).json({
    success: true,
    data: {
      inquiry,
      // Truthful owner-notification outcome: `sent` is true only when the email
      // provider accepted the message — never an assumed success.
      ownerNotification: { status: notification.status, sent: notification.status === 'SENT' },
      message: 'Thank you! Your inquiry has been received and our team will get back to you.',
    },
  });
});

/** The signed-in user's own contact/project inquiries. */
export const listContactInquiries = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const inquiries = await prisma.contactInquiry.findMany({
    where: { userId: req.user.id },
    select: {
      id: true,
      businessName: true,
      service: true,
      budgetRange: true,
      message: true,
      status: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  res.status(200).json({ success: true, data: { inquiries } });
});
