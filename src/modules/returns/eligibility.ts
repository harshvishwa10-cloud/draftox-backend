/**
 * Pure return-eligibility rules (post-delivery, within the return window).
 *
 * Eligibility is always computed from the server-side VERIFIED delivery
 * timestamp (Shipment.deliveredAt, set once by an admin on DELIVERED) — never
 * from anything the customer or the browser supplies. When no verified
 * timestamp exists yet the request is still accepted but flagged for manual
 * eligibility review.
 */
import type { FulfillmentStatus } from '@prisma/client';

export type ReturnEligibility =
  | { status: 'NOT_DELIVERED'; deliveredAt: null; deadline: null; needsReview: false }
  | { status: 'EXPIRED'; deliveredAt: Date; deadline: Date; needsReview: false }
  | { status: 'ELIGIBLE'; deliveredAt: Date; deadline: Date; needsReview: false }
  | { status: 'ELIGIBLE'; deliveredAt: null; deadline: null; needsReview: true };

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

/** True when `now` is strictly after the return-window deadline. */
export function isPastDeadline(now: Date, deadline: Date): boolean {
  return now.getTime() > deadline.getTime();
}

export function computeReturnEligibility(
  fulfillmentStatus: string | FulfillmentStatus,
  deliveredAt: Date | null | undefined,
  windowDays: number,
  now: Date = new Date(),
): ReturnEligibility {
  if (fulfillmentStatus !== 'DELIVERED') {
    return { status: 'NOT_DELIVERED', deliveredAt: null, deadline: null, needsReview: false };
  }
  if (!deliveredAt) {
    // Delivered but the verified timestamp is missing → accept + manual review.
    return { status: 'ELIGIBLE', deliveredAt: null, deadline: null, needsReview: true };
  }
  const deadline = addDays(deliveredAt, windowDays);
  if (isPastDeadline(now, deadline)) {
    return { status: 'EXPIRED', deliveredAt, deadline, needsReview: false };
  }
  return { status: 'ELIGIBLE', deliveredAt, deadline, needsReview: false };
}