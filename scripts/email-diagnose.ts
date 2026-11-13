/**
 * Safe email-delivery diagnostic (no orders, no DB writes, no customer data).
 *
 * Reports which transport the running config selects (presence only — secret
 * values are never printed), runs an auth-only SMTP probe, and optionally sends
 * one clearly-labelled test message to the configured admin inbox.
 *
 * Usage:
 *   npx tsx scripts/email-diagnose.ts            # config + SMTP auth probe
 *   npx tsx scripts/email-diagnose.ts --send     # + one test email to the admin
 *   npx tsx scripts/email-diagnose.ts --send --to you@example.com
 *
 * To diagnose a specific env file (dotenv's native override):
 *   $env:DOTENV_CONFIG_PATH='.env.production'; npx tsx scripts/email-diagnose.ts
 *
 * The test message contains only a timestamp and the transport name. It does
 * not create or modify an order, notification row, payment, or any other record.
 */
import {
  diagnoseEmailConfig,
  isMailerReady,
  maskEmail,
  probeEmailTransport,
  sendMail,
} from '../src/lib/mailer.js';
import { emailFromAddress, env, ownerNotificationEmail } from '../src/config/env.js';

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function line(event: string, data: Record<string, unknown> = {}): void {
  process.stdout.write(JSON.stringify({ event, ...data }) + '\n');
}

async function main(): Promise<void> {
  const report = diagnoseEmailConfig();
  line('email_config', {
    overall: report.overall,
    provider: report.provider,
    from: emailFromAddress ? maskEmail(emailFromAddress) : null,
    adminRecipient: ownerNotificationEmail?.trim()
      ? maskEmail(ownerNotificationEmail.trim())
      : null,
    checks: report.checks.map((c) => `${c.key}=${c.present ? 'present' : 'MISSING'}`),
    warnings: report.warnings,
  });

  if (!isMailerReady) {
    line('result', { ok: false, reason: 'no email transport is configured' });
    process.exitCode = 1;
    return;
  }

  const probe = await probeEmailTransport();
  line('transport_probe', {
    provider: probe.provider,
    ok: probe.ok,
    // nodemailer text such as `535-5.7.8 ... BadCredentials`; never credentials.
    error: probe.error,
  });

  if (!process.argv.includes('--send')) {
    line('result', { ok: probe.ok !== false, note: 'auth-only probe; re-run with --send for a test email' });
    if (probe.ok === false) process.exitCode = 1;
    return;
  }

  const to = (argValue('--to') ?? ownerNotificationEmail ?? '').trim();
  if (!to) {
    line('result', { ok: false, reason: 'no admin recipient configured (OWNER_NOTIFICATION_EMAIL / ADMIN_EMAIL)' });
    process.exitCode = 1;
    return;
  }

  const sentAt = new Date().toISOString();
  const subject = 'DRAFTOX SMTP test — no order, no action needed';
  const text = [
    'DRAFTOX email delivery test',
    '',
    `Sent at: ${sentAt}`,
    `Transport: ${probe.provider === 'smtp' ? 'SMTP' : 'Brevo HTTP'}`,
    `Environment: ${env.NODE_ENV}`,
    '',
    'This is a connectivity test only. No customer data is included, no order',
    'was created, and no database record was changed. This message can be ignored.',
  ].join('\n');

  const result = await sendMail({
    to,
    subject,
    text,
    html:
      '<p><strong>DRAFTOX email delivery test</strong></p>' +
      `<p>Sent at: ${sentAt}<br>Transport: ${probe.provider === 'smtp' ? 'SMTP' : 'Brevo HTTP'}<br>Environment: ${env.NODE_ENV}</p>` +
      '<p>This is a connectivity test only. No customer data is included, no order was created, ' +
      'and no database record was changed. This message can be ignored.</p>',
  });

  line('test_email', {
    to: maskEmail(to),
    // `accepted` means the provider accepted the message — not inbox delivery.
    accepted: result.accepted,
    messageId: result.messageId,
    error: result.error,
  });
  if (!result.accepted) process.exitCode = 1;
}

main().catch((err) => {
  process.stderr.write(
    `email-diagnose failed: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
