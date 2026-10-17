/**
 * Payment-subsystem monitoring. Pure-ish operational checks that raise or clear
 * alerts via src/lib/alerts.ts. Everything here is best-effort and fail-safe:
 * a monitoring failure must never affect a real payment or refund, so every
 * check catches its own errors and reports rather than throwing.
 *
 * These functions are called from the scheduled worker (scripts/scheduler.ts) and
 * the standalone reconciliation script. They never move money.
 */
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { clearAlert, sendAlert } from '../../lib/alerts.js';
import type { ReconcileBatchSummary } from './reconciliation.js';

/** Refunds must be initiated within this many hours of the obligation arising. */
export const REFUND_SLA_HOURS = 24;

/** Cutoff before which a non-SUCCESS refund is "at risk" of missing the goal. */
export function refundSlaCutoff(now: number = Date.now()): Date {
  return new Date(now - REFUND_SLA_HOURS * 60 * 60 * 1000);
}

/** Counts refunds that have not completed within the SLA window. */
export async function countRefundsAtRisk(now: number = Date.now()): Promise<number> {
  return prisma.refund.count({
    where: { status: { not: 'SUCCESS' }, createdAt: { lt: refundSlaCutoff(now) } },
  });
}

/**
 * Verifies the database is reachable with a trivial round-trip. Alerts on
 * failure and clears the alert (once) on recovery.
 */
export async function checkDatabaseConnectivity(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    await clearAlert('database_unreachable', {
      title: 'Database connectivity recovered',
      message: 'The DRAFTOX database is reachable again.',
    });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('monitoring_database_unreachable', { error: message });
    await sendAlert({
      key: 'database_unreachable',
      severity: 'critical',
      title: 'Database unreachable',
      message: 'The DRAFTOX backend could not reach its database.',
      metadata: { error: message },
    });
    return false;
  }
}

/**
 * Flags refunds that are still not SUCCESS past the 24-hour goal, and clears the
 * alert once none remain. Never attempts the refund itself.
 */
export async function checkRefundSla(now: number = Date.now()): Promise<number> {
  let atRisk = 0;
  try {
    atRisk = await countRefundsAtRisk(now);
  } catch (err) {
    logger.error('monitoring_refund_sla_check_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }

  if (atRisk > 0) {
    await sendAlert({
      key: 'refund_sla_breach',
      severity: 'critical',
      title: 'Refunds pending beyond the 24-hour goal',
      message: `${atRisk} refund(s) have not completed within the ${REFUND_SLA_HOURS}-hour goal. Review the refunds queue and retry or complete them manually.`,
      metadata: { refundsAtRisk: atRisk, slaHours: REFUND_SLA_HOURS },
      at: new Date(now),
    });
  } else {
    await clearAlert(
      'refund_sla_breach',
      {
        title: 'Refund SLA recovered',
        message: 'No refunds are past the 24-hour goal.',
      },
      now,
    );
  }
  return atRisk;
}

/**
 * Alerts when a reconciliation sweep reported failures; clears once a sweep
 * completes with none. `reconciled` counts are informational only.
 */
export async function reportReconcileOutcome(
  summary: ReconcileBatchSummary,
  now: number = Date.now(),
): Promise<void> {
  if (summary.failed > 0) {
    await sendAlert({
      key: 'reconcile_job_failed',
      severity: 'warning',
      title: 'Payment reconciliation reported failures',
      message: `${summary.failed} of ${summary.scanned} scanned order(s) failed to reconcile and will be retried on the next run.`,
      metadata: {
        scanned: summary.scanned,
        reconciled: summary.reconciled,
        pending: summary.pending,
        failed: summary.failed,
      },
      at: new Date(now),
    });
  } else {
    await clearAlert(
      'reconcile_job_failed',
      {
        title: 'Reconciliation recovered',
        message: 'The latest payment reconciliation sweep completed with no failures.',
      },
      now,
    );
  }
}
