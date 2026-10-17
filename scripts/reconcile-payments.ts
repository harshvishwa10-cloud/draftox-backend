/**
 * Standalone payment-reconciliation job.
 *
 * Safety net for missed/failed Razorpay webhooks: scans online orders that are
 * still REQUESTED/CONFIRMED, have a Razorpay order, and are older than a grace
 * period, then asks the provider which captured payment (if any) matches. An
 * exact captured match marks the order PAID; anything else is left for the next
 * run or surfaced as a PaymentException.
 *
 * It is database-driven (no in-memory queue) and bounded/sequential, so it is
 * safe to run from a cron / scheduled worker. It performs NO refunds and never
 * marks a cancelled order paid.
 *
 * Usage:
 *   npx tsx scripts/reconcile-payments.ts [olderThanMinutes=10] [limit=25]
 *
 * Suggested schedule (document how the operator enables it — not run by the app):
 *   every 10 minutes:    npx tsx scripts/reconcile-payments.ts 10 25
 *
 * NOTE: this reads the same environment as the API (DATABASE_URL, RAZORPAY_*).
 */
import { prisma } from '../src/lib/prisma.js';
import { reconcilePendingPayments } from '../src/modules/payments/reconciliation.js';
import { reportReconcileOutcome } from '../src/modules/payments/monitoring.js';

function toPositiveInt(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

async function main(): Promise<void> {
  const olderThanMinutes = toPositiveInt(process.argv[2], 10);
  const limit = toPositiveInt(process.argv[3], 25);

  const summary = await reconcilePendingPayments({ olderThanMinutes, limit });
  process.stdout.write(
    JSON.stringify({ event: 'reconcile_payments_complete', olderThanMinutes, limit, ...summary }) +
      '\n',
  );
  // Raise/clear a deduplicated operational alert for failures. Never throws.
  await reportReconcileOutcome(summary);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  process.stderr.write(
    `reconcile-payments failed: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});
