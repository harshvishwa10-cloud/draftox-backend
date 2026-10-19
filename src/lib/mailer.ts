import nodemailer from 'nodemailer';
import {
  env,
  emailFrom,
  emailFromAddress,
  emailFromName,
  emailSendTimeoutMs,
  mailerConfigured,
  brevoConfigured,
  publicSiteUrl,
  isTest,
} from '../config/env.js';
import { logger } from './logger.js';

export interface MailResult {
  /** True only when the provider accepted/enqueued the message. */
  accepted: boolean;
  /** The provider-assigned message id, when reported. */
  messageId: string | null;
  /** Human-safe error summary (never credentials). */
  error: string | null;
}

/** True when any email transport (Brevo HTTP API or SMTP) is wired up. */
export const isMailerReady = mailerConfigured;

/**
 * Masks the local part of an email address for logs, so a recipient address is
 * never written verbatim (PII minimisation). The domain is kept for debugging.
 */
export function maskEmail(address: string): string {
  const at = address.indexOf('@');
  if (at <= 0) return '***';
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  const head = local.slice(0, 1);
  return `${head}${'*'.repeat(Math.max(local.length - 1, 1))}@${domain}`;
}

const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';

/**
 * Sends one email through Brevo's transactional email HTTP API over HTTPS.
 * Uses native fetch (Node 18+) with a hard AbortSignal timeout — no outbound
 * SMTP ports are touched, so this works on hosts that block SMTP (e.g. Render
 * Free). Returns the same MailResult contract as the SMTP path. Never logs the
 * API key, full request headers, or message content.
 */
async function sendViaBrevo(input: {
  to: string;
  subject: string;
  html: string;
  text: string;
}): Promise<MailResult> {
  const apiKey = (env.BREVO_API_KEY ?? '').trim();
  if (!apiKey) {
    return {
      accepted: false,
      messageId: null,
      error: 'BREVO_API_KEY is not configured on the server.',
    };
  }

  const body = {
    sender: { email: emailFromAddress, name: emailFromName },
    to: [{ email: input.to }],
    subject: input.subject,
    htmlContent: input.html,
    textContent: input.text,
  };

  try {
    const response = await fetch(BREVO_API_URL, {
      method: 'POST',
      headers: {
        'api-key': apiKey,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(body),
      // Hard bound on the whole HTTP round-trip, mirroring the SMTP race.
      signal: AbortSignal.timeout(emailSendTimeoutMs),
    });

    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      // Non-JSON body is fine; we only need the status code.
    }

    if (response.ok) {
      // Brevo returns 201 with a `messageId`. That means Brevo ACCEPTED and
      // queued the message — NOT that it reached the recipient's inbox.
      const messageId =
        payload && typeof payload === 'object' && 'messageId' in payload
          ? String((payload as { messageId: unknown }).messageId)
          : null;
      logger.info('mail_brevo_accepted', { to: maskEmail(input.to), messageId });
      return { accepted: true, messageId, error: null };
    }

    // Non-2xx: extract only the safe code/message fields, never the request.
    let code: string | null = null;
    let message: string | null = null;
    if (payload && typeof payload === 'object') {
      const p = payload as { code?: unknown; message?: unknown };
      if (typeof p.code === 'string') code = p.code;
      if (typeof p.message === 'string') message = p.message;
    }
    logger.warn('mail_brevo_rejected', {
      to: maskEmail(input.to),
      status: response.status,
      code,
    });
    return {
      accepted: false,
      messageId: null,
      error: `Brevo API rejected the request (HTTP ${response.status}${code ? `, ${code}` : ''})${message ? `: ${message.slice(0, 200)}` : '.'}`,
    };
  } catch (err) {
    // Network failure or AbortSignal timeout. err.message is safe (contains
    // the timeout duration or a fetch error string — never the API key).
    const safe = err instanceof Error ? err.message : String(err);
    logger.error('mail_brevo_failed', { to: maskEmail(input.to), error: safe });
    return {
      accepted: false,
      messageId: null,
      error: safe.slice(0, 500),
    };
  }
}

export interface EmailConfigCheck {
  /** Env key name. No values are ever reported — only presence. */
  key: string;
  required: boolean;
  present: boolean;
  comment: string;
}

export interface EmailConfigDiagnosis {
  provider: 'none' | 'smtp' | 'brevo';
  /** ready: transport fully present; incomplete: required keys missing; disabled: no transport. */
  overall: 'ready' | 'incomplete' | 'disabled';
  checks: EmailConfigCheck[];
  warnings: string[];
}

/**
 * Reports whether email delivery is wired up — PRESENCE only, never values, so
 * it is safe to log at startup. `BREVO_API_KEY` and `SMTP_PASS` appear solely as
 * present/absent booleans. Used by `logEmailConfigDiagnostics()` and unit tests.
 */
export function diagnoseEmailConfig(): EmailConfigDiagnosis {
  const checks: EmailConfigCheck[] = [];
  const warnings: string[] = [];

  if (brevoConfigured) {
    checks.push({ key: 'BREVO_API_KEY', required: true, present: true, comment: 'Brevo transactional email API configured' });
    const from = (env.EMAIL_FROM ?? '').trim();
    checks.push({ key: 'EMAIL_FROM', required: false, present: from.length > 0, comment: from.length > 0 ? '' : 'unset — falls back to SMTP_USER or SUPPORT_EMAIL' });
    checks.push({ key: 'EMAIL_FROM_NAME', required: false, present: Boolean(env.EMAIL_FROM_NAME?.trim()), comment: env.EMAIL_FROM_NAME?.trim() ? '' : 'unset — defaults to "DRAFTOX"' });
    checks.push({ key: 'OWNER_NOTIFICATION_EMAIL', required: false, present: Boolean(env.OWNER_NOTIFICATION_EMAIL?.trim()), comment: env.OWNER_NOTIFICATION_EMAIL?.trim() ? '' : 'unset — falls back to ADMIN_EMAIL' });
    checks.push({ key: 'SUPPORT_EMAIL', required: true, present: true, comment: 'shown in the email footer' });
    return { provider: 'brevo', overall: 'ready', checks, warnings };
  }

  if (env.EMAIL_PROVIDER === 'none') {
    return {
      provider: 'none',
      overall: 'disabled',
      checks: [
        {
          key: 'EMAIL_PROVIDER',
          required: true,
          present: true,
          comment: 'currently "none" (delivery disabled)',
        },
      ],
      warnings: [
        'EMAIL_PROVIDER is not "smtp" — shipment and password-reset emails are NOT sent. ' +
          'To enable Gmail delivery, set EMAIL_PROVIDER=smtp and provide SMTP_HOST/SMTP_PORT/' +
          'SMTP_USER/SMTP_PASS (see .env.example).',
      ],
    };
  }

  checks.push({ key: 'EMAIL_PROVIDER', required: true, present: true, comment: 'set to "smtp"' });

  const host = (env.SMTP_HOST ?? '').trim();
  checks.push({ key: 'SMTP_HOST', required: true, present: host.length > 0, comment: '' });

  const port = env.SMTP_PORT;
  checks.push({
    key: 'SMTP_PORT',
    required: true,
    present: Boolean(port),
    comment: port
      ? `port ${port} (${port === 465 ? 'implicit TLS' : 'STARTTLS'})`
      : 'defaults to 587 (STARTTLS)',
  });

  const user = (env.SMTP_USER ?? '').trim();
  checks.push({ key: 'SMTP_USER', required: true, present: user.length > 0, comment: '' });

  const pass = env.SMTP_PASS ?? '';
  checks.push({
    key: 'SMTP_PASS',
    required: true,
    present: pass.length > 0,
    comment: pass.length > 0
      ? ''
      : 'set but empty — Gmail requires a 16-character App Password (soft warning: bare relays without auth still work)',
  });

  const from = (env.EMAIL_FROM ?? '').trim();
  checks.push({
    key: 'EMAIL_FROM',
    required: false,
    present: from.length > 0,
    comment: from.length > 0 ? '' : 'unset — falls back to SMTP_USER',
  });

  if (/(?:^|\.)(gmail|googlemail)\.com$/i.test(host)) {
    if (from.length > 0 && user && !from.includes(`<${user}>`)) {
      checks.push({
        key: 'EMAIL_FROM',
        required: true,
        present: true,
        comment: 'warned below',
      });
      warnings.push(
        'The SMTP host looks like Gmail, and EMAIL_FROM does not match SMTP_USER. ' +
          'Gmail rejects messages whose From address does not match the authenticated account. ' +
          'Set EMAIL_FROM to the same address as SMTP_USER (or leave it unset so it falls back).',
      );
    }
  }

  const missing = checks.filter((c) => c.required && !c.present);
  if (missing.length > 0) {
    warnings.push(
      `SMTP is incomplete — missing required settings: ${missing.map((c) => c.key).join(', ')}. ` +
        'Add them to the backend .env and restart.',
    );
    return { provider: 'smtp', overall: 'incomplete', checks, warnings };
  }

  checks.push({
    key: 'PUBLIC_SITE_URL',
    required: false,
    present: Boolean(env.PUBLIC_SITE_URL?.trim()),
    comment: env.PUBLIC_SITE_URL
      ? `tracking links use ${publicSiteUrl}`
      : `unset — tracking links fall back to FRONTEND_URL (${publicSiteUrl})`,
  });
  if (!env.PUBLIC_SITE_URL) {
    warnings.push(
      `PUBLIC_SITE_URL is unset — customer tracking links in emails point to ${publicSiteUrl}. ` +
        'Set it to the real site origin in production so recipients reach a working page.',
    );
  }

  checks.push({
    key: 'SUPPORT_EMAIL',
    required: true,
    present: true,
    comment: 'shown in the email footer',
  });

  return { provider: 'smtp', overall: 'ready', checks, warnings };
}

/** Logs presence-only startup diagnostics. Skipped under vitest whose env is synthetic. */
export function logEmailConfigDiagnostics(): void {
  if (isTest) return;
  const report = diagnoseEmailConfig();
  if (report.overall === 'ready') {
    logger.info('email_delivery_ready', { provider: report.provider });
  } else if (report.overall === 'incomplete') {
    logger.warn('email_delivery_incomplete', {
      provider: report.provider,
      missing: report.checks.filter((c) => c.required && !c.present).map((c) => c.key),
    });
  } else {
    logger.warn('email_delivery_disabled', { provider: report.provider });
  }
  for (const warning of report.warnings) {
    logger.warn('email_config_hint', { message: warning });
  }
}

function createTransport() {
  if (!env.SMTP_HOST || !env.SMTP_USER) {
    throw new Error('SMTP is not configured (missing SMTP_HOST or SMTP_USER)');
  }
  const port = env.SMTP_PORT;
  return nodemailer.createTransport({
    host: env.SMTP_HOST,
    port,
    // Port 465 = implicit TLS; 587/25/others = STARTTLS (nodemailer picks up automatically).
    secure: port === 465,
    auth: {
      user: env.SMTP_USER,
      pass: env.SMTP_PASS ?? '',
    },
    // Bound every stage of the SMTP round-trip. Defaults are 2 min (connect),
    // 30s (greeting) and 10 min (socket idle) - far beyond the storefront
    // client's 15s abort, which turned a blocked SMTP port (e.g. Render Free
    // blocks 25/465/587 outbound) into a bogus "Could not reach the server".
    connectionTimeout: emailSendTimeoutMs,
    greetingTimeout: emailSendTimeoutMs,
    socketTimeout: emailSendTimeoutMs,
  });
}

/**
 * Sends a single email. Returns a result describing what happened; NEVER throws
 * transport errors to the caller - they are captured so a failed send can never
 * break the shipment that triggered it. The caller decides how to record the
 * outcome. The attempt is bounded by EMAIL_SEND_TIMEOUT_MS (default 8s).
 *
 * When BREVO_API_KEY is set, the message is routed through Brevo's transactional
 * email HTTP API (HTTPS) — no outbound SMTP ports are used. Otherwise the
 * legacy nodemailer SMTP path is used if EMAIL_PROVIDER=smtp is configured.
 */
export async function sendMail(input: {
  to: string;
  subject: string;
  html: string;
  text: string;
}): Promise<MailResult> {
  if (!isMailerReady) {
    logger.warn('mail_not_sent_provider_not_configured', { to: maskEmail(input.to) });
    return {
      accepted: false,
      messageId: null,
      error: 'Email provider is not configured. Set BREVO_API_KEY (Brevo HTTP API) or EMAIL_PROVIDER=smtp with SMTP_HOST/SMTP_USER to enable sending.',
    };
  }

  if (!input.to || !input.to.trim()) {
    logger.warn('mail_not_sent_no_recipient');
    return {
      accepted: false,
      messageId: null,
      error: 'No recipient email address was provided.',
    };
  }

  // Brevo HTTP API takes precedence when configured — no outbound SMTP is used.
  if (brevoConfigured) {
    return sendViaBrevo(input);
  }

  try {
    const transport = createTransport();
    const sendPromise = transport.sendMail({
      from: emailFrom,
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
    });
    // If the race below times out, a LATE rejection of the real send must never
    // surface as an unhandled rejection (Node would log it and, under
    // unhandledRejection policy in index.ts, shut the server down).
    sendPromise.catch(() => undefined);

    // Hard bound on the whole attempt, independent of the per-stage transport
    // timeouts: a blocked or hung SMTP connection (e.g. Render Free drops
    // outbound SMTP) resolves to a truthful failure instead of holding the
    // HTTP request open past the storefront client's 15s abort.
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`Email send timed out after ${emailSendTimeoutMs}ms.`));
      }, emailSendTimeoutMs);
      timer.unref?.();
    });

    let info: { accepted?: unknown; messageId?: unknown };
    try {
      info = await Promise.race([sendPromise, timedOut]);
    } finally {
      if (timer) clearTimeout(timer);
    }

    // `accepted`/`messageId` are provider acceptance signals, NOT delivery.
    const accepted = Array.isArray(info.accepted) && info.accepted.length > 0;
    const messageId = typeof info.messageId === 'string' ? info.messageId : null;

    if (!accepted) {
      logger.warn('mail_rejected_by_provider', { to: maskEmail(input.to) });
      return {
        accepted: false,
        messageId,
        error: 'The email provider rejected the recipient address.',
      };
    }

    return { accepted: true, messageId, error: null };
  } catch (err) {
    const safe = err instanceof Error ? err.message : String(err);
    logger.error('mail_send_failed', { error: safe });
    return {
      accepted: false,
      messageId: null,
      error: safe.slice(0, 500),
    };
  }
}
