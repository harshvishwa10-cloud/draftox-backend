import type { Request, Response } from 'express';
import { prisma } from '../../lib/prisma.js';
import { ApiError } from '../../utils/ApiError.js';
import { asyncHandler } from '../../utils/asyncHandler.js';

/** Select only what the public tracking page needs — never expose email/phone. */
const trackingSelect = {
  courierName: true,
  trackingNumber: true,
  trackingUrl: true,
  dispatchNotes: true,
  dispatchedAt: true,
  estimatedDeliveryAt: true,
  trackingTokenCreatedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * Public shipment tracking lookup by opaque token. Login-free and indexable
 * only via the explicit `<meta name="robots" content="noindex">` on the page.
 * No PII (email/phone/address) is returned — only courier/tracking info.
 */
export const getTracking = asyncHandler(async (req: Request, res: Response) => {
  const token = String(req.params.token ?? '').trim();
  if (!token) {
    throw ApiError.badRequest('Tracking token is required');
  }

  const shipment = await prisma.shipment.findUnique({
    where: { trackingToken: token },
    select: {
      ...trackingSelect,
      order: {
        select: {
          orderNumber: true,
          name: true,
        },
      },
    },
  });

  if (!shipment) {
    throw ApiError.notFound('No shipment found for this tracking token');
  }

  res.status(200).json({
    success: true,
    data: {
      orderNumber: shipment.order.orderNumber,
      courierName: shipment.courierName,
      trackingNumber: shipment.trackingNumber,
      trackingUrl: shipment.trackingUrl,
      dispatchNotes: shipment.dispatchNotes,
      dispatchedAt: shipment.dispatchedAt,
      estimatedDeliveryAt: shipment.estimatedDeliveryAt,
      trackingTokenCreatedAt: shipment.trackingTokenCreatedAt,
      shipmentCreatedAt: shipment.createdAt,
      shipmentUpdatedAt: shipment.updatedAt,
      customerName: shipment.order.name,
    },
  });
});
