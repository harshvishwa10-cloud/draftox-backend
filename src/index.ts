import { createApp } from './app.js';
import { env } from './config/env.js';
import { closeCache } from './lib/cache.js';
import { prisma } from './lib/prisma.js';
import { logger } from './lib/logger.js';
import { logEmailConfigDiagnostics, probeEmailTransport, isMailerReady } from './lib/mailer.js';
import { logPaymentsDiagnostics } from './modules/payments/payments.diagnostics.js';
import { repairMissingPaidOrderNotifications } from './modules/orders/paidNotificationRepair.js';

async function main(): Promise<void> {
  // Fail fast if the database is unreachable.
  await prisma.$connect();
  logger.info('database_connected');

  // Presence-only email config summary (never logs secret values).
  logEmailConfigDiagnostics();

  // Presence-only Razorpay config summary (never logs secret values).
  logPaymentsDiagnostics();

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info('server_started', {
      port: env.PORT,
      nodeEnv: env.NODE_ENV,
    });

    /*
     * Both post-listen jobs are fire-and-forget: readiness and request handling
     * must never wait on (or fail because of) an email round-trip.
     *
     * 1. Auth-only transport probe — makes a broken mailbox visible in the boot
     *    logs without sending mail.
     * 2. Paid-order notification repair — dispatches the store-team email for
     *    orders that became PAID while the trigger was missing (e.g. orders
     *    paid before the online-paid hook shipped). It is idempotent and only
     *    touches orders with no accepted internal notification.
     */
    void probeEmailTransport().catch(() => undefined);

    // Render sets RENDER=true on every service, so the repair also runs if
    // NODE_ENV was left unset there. Local dev DBs are never touched.
    const deployed = env.NODE_ENV === 'production' || Boolean(process.env.RENDER);
    if (!deployed) {
      logger.info('paid_notification_repair_skipped_not_deployed');
    } else if (!isMailerReady) {
      logger.warn('paid_notification_repair_skipped_email_not_configured');
    } else {
      void repairMissingPaidOrderNotifications().catch(() => undefined);
    }
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutdown_started', { signal });

    const forceExit = setTimeout(() => {
      logger.error('shutdown_forced_timeout');
      process.exit(1);
    }, 10_000);
    forceExit.unref();

    server.close(async (err) => {
      try {
        await prisma.$disconnect();
        logger.info('database_disconnected');
      } catch (disconnectErr) {
        logger.error('database_disconnect_error', {
          message: disconnectErr instanceof Error ? disconnectErr.message : String(disconnectErr),
        });
      }
      try {
        // Safe no-op when Redis was never configured or used.
        await closeCache();
        logger.info('cache_closed');
      } catch (cacheErr) {
        logger.error('cache_close_error', {
          message: cacheErr instanceof Error ? cacheErr.message : String(cacheErr),
        });
      }
      if (err) {
        logger.error('server_close_error', { message: err.message });
        process.exit(1);
      }
      logger.info('shutdown_complete');
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    // A rejected promise with no handler means the process may be in an
    // inconsistent state (a request could be left half-processed). Log it and
    // shut down cleanly so the orchestrator can restart a healthy instance,
    // matching Node's own fatal-by-default policy.
    logger.error('unhandled_rejection', {
      message: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
    shutdown('unhandledRejection');
  });

  process.on('uncaughtException', (err) => {
    logger.error('uncaught_exception', { message: err.message, stack: err.stack });
    shutdown('uncaughtException');
  });
}

main().catch((err) => {
  logger.error('server_start_failed', {
    message: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
