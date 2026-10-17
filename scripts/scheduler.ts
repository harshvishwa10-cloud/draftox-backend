/**
 * DRAFTOX payment operations worker.
 *
 * A long-running, hosting-agnostic scheduler that periodically runs the
 * payment safety nets: database connectivity, the reconciliation sweep, and the
 * refund-SLA check. It is safe to run as a single instance on any always-on host
 * (systemd, pm2, Docker, a small VM, a container sidecar):
 *
 *   npm run scheduler
 *
 * It does NOT assume a cron daemon exists. If your platform prefers cron /
 * scheduled jobs instead of a long-running process, run the one-shot entrypoint
 * on a schedule and skip this worker:
 *
 *   every 10 minutes:  npx tsx scripts/reconcile-payments.ts 10 25
 *
 * Safety properties:
 *  - OVERLAP-SAFE within a process: a run in progress makes the next tick a
 *    no-op, so slow provider calls cannot stack up.
 *  - IDEMPOTENT across processes: the underlying reconciliation uses guarded
 *    updates, so even two workers racing can never double-mark an order PAID or
 *    double-refund. Coordination is the underlying DB state, not a lock.
 *  - BOUNDED: each sweep reads at most RECONCILE_BATCH_SIZE orders and applies a
 *    per-provider timeout (see reconciliation.ts).
 *  - FAIL-SAFE: every failure is logged and (for real failures) alerts; the loop
 *    keeps going and no alert path can crash the worker.
 *  - NO MONEY MOVEMENT: it never refunds and never marks a cancelled order paid.
 *
 * Configuration (all optional; sensible defaults):
 *   SCHEDULER_INTERVAL_MINUTES   how often a cycle runs        (default 10)
 *   RECONCILE_GRACE_MINUTES      age before an order is swept  (default 10)
 *   RECONCILE_BATCH_SIZE         max orders per sweep          (default 25)
 */
import { prisma } from '../src/lib/prisma.js';
import { logger } from '../src/lib/logger.js';
import { sendAlert } from '../src/lib/alerts.js';
import { reconcilePendingPayments } from '../src/modules/payments/reconciliation.js';
import {
  checkDatabaseConnectivity,
  checkRefundSla,
  reportReconcileOutcome,
} from '../src/modules/payments/monitoring.js';

function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

const intervalMinutes = positiveIntEnv('SCHEDULER_INTERVAL_MINUTES', 10);
const olderThanMinutes = positiveIntEnv('RECONCILE_GRACE_MINUTES', 10);
const batchSize = positiveIntEnv('RECONCILE_BATCH_SIZE', 25);

let cycleRunning = false;
let currentCycle: Promise<void> | null = null;
let shuttingDown = false;

/** Runs one monitoring cycle. Never throws; reports failures through alerts. */
async function runCycle(): Promise<void> {
  if (cycleRunning) {
    logger.warn('scheduler_cycle_skipped', { reason: 'previous_cycle_still_running' });
    return;
  }
  cycleRunning = true;
  const startedAt = Date.now();
  try {
    const dbOk = await checkDatabaseConnectivity();
    if (!dbOk) {
      logger.error('scheduler_cycle_aborted', { reason: 'database_unreachable' });
      return;
    }

    const summary = await reconcilePendingPayments({ olderThanMinutes, limit: batchSize });
    logger.info('scheduler_reconcile_complete', {
      ...summary,
      durationMs: Date.now() - startedAt,
    });
    await reportReconcileOutcome(summary);

    const refundsAtRisk = await checkRefundSla();
    logger.info('scheduler_refund_sla_checked', { refundsAtRisk });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('scheduler_cycle_failed', { error: message });
    await sendAlert({
      key: 'payment_scheduler_failed',
      severity: 'critical',
      title: 'Payment operations worker cycle failed',
      message: 'A scheduled payment monitoring cycle threw an unexpected error.',
      metadata: { error: message },
    });
  } finally {
    cycleRunning = false;
  }
}

async function main(): Promise<void> {
  logger.info('scheduler_started', { intervalMinutes, olderThanMinutes, batchSize });

  // Run once immediately so a fresh restart self-heals without waiting a cycle.
  currentCycle = runCycle();
  await currentCycle;

  const timer = setInterval(() => {
    if (shuttingDown) return;
    currentCycle = runCycle();
  }, intervalMinutes * 60_000);
  // Do not keep the event loop alive solely for the timer on graceful shutdown.
  timer.unref?.();

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('scheduler_stopping', { signal });
    clearInterval(timer);
    // Let an in-flight cycle finish (bounded) so we never disconnect the DB
    // mid-write. The cycle is idempotent, so a timeout is still safe.
    if (currentCycle) {
      await Promise.race([
        currentCycle.catch(() => undefined),
        new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 10_000);
          t.unref?.();
        }),
      ]);
    }
    await prisma.$disconnect().catch(() => undefined);
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch(async (err) => {
  logger.error('scheduler_fatal', {
    error: err instanceof Error ? err.message : String(err),
  });
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});
