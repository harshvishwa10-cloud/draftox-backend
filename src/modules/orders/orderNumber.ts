import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { ApiError } from '../../utils/ApiError.js';

/**
 * Customer-facing order numbers live in a fixed 5-digit space. They are stored
 * as text (so a leading zero could survive) and are allocated from a single
 * database counter row. Allocation happens inside the order-creation
 * transaction, so:
 *   - concurrent checkouts are serialised by the row lock and can never share a
 *     number;
 *   - if the transaction rolls back, the number is released (not consumed).
 */
export const ORDER_NUMBER_MIN = 10000;
export const ORDER_NUMBER_MAX = 99999;
export const ORDER_NUMBER_PATTERN = /^\d{5}$/;
export const ORDER_COUNTER_KEY = 'order_number';

/** True when `value` is a well-formed DRAFTOX order number (10000–99999). */
export function isOrderNumber(value: string): boolean {
  if (!ORDER_NUMBER_PATTERN.test(value)) return false;
  const n = Number(value);
  return n >= ORDER_NUMBER_MIN && n <= ORDER_NUMBER_MAX;
}

/**
 * Atomically reserves the next order number within an open transaction.
 * Throws an operational 503 once the 90,000-number space is exhausted — it
 * never reuses or fabricates a duplicate.
 */
export async function reserveOrderNumber(tx: Prisma.TransactionClient): Promise<string> {
  // The row is created by the migration; this upsert is a safety net for
  // fresh databases and never runs when the counter already exists.
  await tx.$executeRaw`
    INSERT INTO "OrderCounter" ("key", "value")
    VALUES (${ORDER_COUNTER_KEY}, ${ORDER_NUMBER_MIN - 1})
    ON CONFLICT ("key") DO NOTHING
  `;

  const rows = await tx.$queryRaw<Array<{ value: number }>>`
    UPDATE "OrderCounter"
    SET "value" = "value" + 1
    WHERE "key" = ${ORDER_COUNTER_KEY}
    RETURNING "value"
  `;

  const value = rows[0]?.value;
  if (typeof value !== 'number') {
    throw ApiError.serviceUnavailable(
      'Order numbering is temporarily unavailable. Please try again in a moment.',
    );
  }
  if (value > ORDER_NUMBER_MAX) {
    // Throwing rolls the transaction back, so the counter is left exhausted and
    // the next attempt fails the same way instead of duplicating a number.
    throw new ApiError(
      503,
      'ORDER_NUMBER_EXHAUSTED',
      `The order-number space is exhausted: all ${ORDER_NUMBER_MAX - ORDER_NUMBER_MIN + 1} numbers in ${ORDER_NUMBER_MIN}–${ORDER_NUMBER_MAX} are allocated. New orders cannot be created until the range is extended.`,
    );
  }
  return String(value);
}

/** Current allocator value, for diagnostics/tests. */
export async function currentOrderNumberValue(): Promise<number> {
  const row = await prisma.orderCounter.findUnique({ where: { key: ORDER_COUNTER_KEY } });
  return row?.value ?? ORDER_NUMBER_MIN - 1;
}
