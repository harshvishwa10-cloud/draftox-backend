import type { Request, Response } from 'express';
import { prisma } from '../../lib/prisma.js';
import { ApiError } from '../../utils/ApiError.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { normalizeEmail } from '../../utils/normalize.js';
import { productInquirySchema } from '../../schemas/productInquiry.schema.js';
import {
  buildOwnerInquiryEmail,
  sendOwnerInquiryEmail,
} from '../notifications/ownerNotifications.js';

export const createProductInquiry = asyncHandler(async (req: Request, res: Response) => {
  const input = productInquirySchema.parse(req.body);

  // Only published products can be publicly inquired about. The storefront may
  // identify the product by backend id or by its stable slug.
  const product = await prisma.product.findFirst({
    where: {
      status: 'PUBLISHED',
      OR: [
        ...(input.productId ? [{ id: input.productId }] : []),
        ...(input.productSlug ? [{ slug: input.productSlug }] : []),
      ],
    },
    select: { id: true, name: true, slug: true },
  });
  if (!product) {
    throw ApiError.notFound('Product not found');
  }

  // The inquiry is persisted first, then the owner notification is attempted
  // AFTER commit and outside any transaction, so a slow SMTP round-trip can
  // never roll back the customer's submission.
  const inquiry = await prisma.$transaction(async (tx) => {
    const created = await tx.productInquiry.create({
      data: {
        // Associate the signed-in user if present; otherwise guest inquiry.
        userId: req.user?.id ?? null,
        productId: product.id,
        customerName: input.customerName,
        email: normalizeEmail(input.email),
        phone: input.phone ?? null,
        quantity: input.quantity ?? null,
        type: input.type,
        message: input.message,
        status: 'NEW',
      },
      select: {
        id: true,
        status: true,
        type: true,
        quantity: true,
        createdAt: true,
        product: { select: { id: true, name: true, slug: true } },
      },
    });

    return created;
  });

  const notification = await sendOwnerInquiryEmail({
    kind: 'PRODUCT',
    refId: inquiry.id,
    idempotencyKey: `product:${inquiry.id}`,
    mail: buildOwnerInquiryEmail({
      kind: 'PRODUCT',
      refId: inquiry.id,
      heading: 'New product enquiry',
      name: input.customerName,
      email: normalizeEmail(input.email),
      phone: input.phone ?? null,
      subject: `Product enquiry: ${product.name}`,
      message: input.message,
      meta: [
        { label: 'Product', value: product.name },
        { label: 'Type', value: input.type },
        { label: 'Quantity', value: input.quantity != null ? String(input.quantity) : null },
      ],
    }),
  });

  res.status(201).json({
    success: true,
    data: {
      inquiry,
      // Honest owner-notification outcome — `sent` only when the provider accepted it.
      ownerNotification: { status: notification.status, sent: notification.status === 'SENT' },
      message: 'Inquiry received. This is not a confirmed order — our team will contact you to confirm availability, pricing and next steps.',
    },
  });
});

/** The signed-in user's own product inquiries. */
export const listProductInquiries = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw ApiError.unauthorized();
  const inquiries = await prisma.productInquiry.findMany({
    where: { userId: req.user.id },
    select: {
      id: true,
      quantity: true,
      type: true,
      message: true,
      status: true,
      createdAt: true,
      product: { select: { id: true, name: true, slug: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  res.status(200).json({ success: true, data: { inquiries } });
});
