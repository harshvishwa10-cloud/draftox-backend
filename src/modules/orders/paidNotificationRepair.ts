import { logger } from '../../lib/logger.js';
import { prisma } from '../../lib/prisma.js';
import { notifyPaidOrder, type PaidOrderNotificationResult } from './orderEmails.js';

/** Only PAID orders from this window are considered by the automatic repair. */
const DEFAULT_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
/** Safety cap: a repair run can never mass-mail the whole order history. */
const DEFAULT_LIMIT = 10;

export interface PaidNotificationRepairOptions {
  since?: Date;
  limit?: number;
  /** Restrict the run to specific order ids (used by tests / one-off repairs). */
  orderIds?: string[];
}

export interface PaidNotificationRepair {
  orderId: string;
  results: PaidOrderNotificationResult[];
}

/**
 * Dispatches the store-team notification for PAID orders whose internal
 * notification was never accepted by a provider.
 *
 * This exists because notifications are triggered on the payment *transition*:
 * an order that was paid before the trigger existed (or while a deploy was in
 * flight) would otherwise never be retried. The check is:
 *
 *   status = PAID
 *   AND no OrderNotification with an `admin-paid:` / `business-paid:` key is SENT
 *
 * `notifyPaidOrder` is idempotent, so a SENT copy is never re-sent and a FAILED
 * row is retried. Only the admin/business recipients are addressed — this never
 * sends a customer email and never mutates the order or payment.
 */
export async function repairMissingPaidOrderNotifications(
  options: PaidNotificationRepairOptions = {},
): Promise<PaidNotificationRepair[]> {
  const since = options.since ?? new Date(Date.now() - DEFAULT_LOOKBACK_MS);
  const limit = options.limit ?? DEFAULT_LIMIT;

  try {
    const orders = await prisma.order.findMany({
      where: {
        status: 'PAID',
        ...(options.orderIds ? { id: { in: options.orderIds } } : { createdAt: { gte: since } }),
        orderNotifications: {
          none: {
            status: 'SENT',
            OR: [
              { idempotencyKey: { startsWith: 'admin-paid:' } },
              { idempotencyKey: { startsWith: 'business-paid:' } },
            ],
          },
        },
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
      select: { id: true, orderNumber: true },
    });

    if (orders.length === 0) {
      logger.info('paid_notification_repair_none_pending');
      return [];
    }

    logger.info('paid_notification_repair_started', { count: orders.length });
    const repaired: PaidNotificationRepair[] = [];
    for (const order of orders) {
      // Sequential on purpose: keeps provider pressure and log ordering sane.
      const results = await notifyPaidOrder(order.id);
      repaired.push({ orderId: order.id, results });
    }
    logger.info('paid_notification_repair_completed', { count: repaired.length });
    return repaired;
  } catch (error) {
    // Never let a repair attempt affect startup or any order/payment state.
    logger.error('paid_notification_repair_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}
