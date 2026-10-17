/**
 * Operational alerting: a tiny, dependency-free alerting façade for the payment
 * subsystem (webhook failures, unresolved exceptions, reconciliation job
 * failures, refunds past the 24-hour goal, backup failures, database
 * connectivity).
 *
 * Design goals:
 *  - FAIL-SAFE: delivering an alert must never throw into, or slow down, the
 *    money path. Every call is wrapped and returns a status instead of raising.
 *  - DEDUPLICATED: each alert has a stable `key`; repeats inside a cooldown
 *    window are suppressed so a burst cannot become an email storm.
 *  - RECOVERABLE: `clearAlert(key)` announces the all-clear exactly once, but
 *    only if the condition was actually raised (delivered) before.
 *  - TRUTHFUL: `sent`/`recovered` mean the configured sink CONFIRMED delivery,
 *    never an aspiration. Delivery failures are reported, not hidden.
 *  - SECRET-FREE: only caller-supplied, already-safe metadata is rendered; no
 *    credentials, tokens or raw provider payloads are ever included.
 *
 * The default sink emails the store owner through the existing mailer. A
 * different sink (chat/webhook/pager) can be registered at startup; tests inject
 * their own sink and reset the module state.
 */
import { ownerNotificationEmail } from '../config/env.js';
import { isMailerReady, sendMail } from './mailer.js';
import { logger } from './logger.js';

export type AlertSeverity = 'warning' | 'critical';

export interface Alert {
  /** Stable dedup/recovery key, e.g. "payment_exception:AMOUNT_MISMATCH". */
  key: string;
  severity: AlertSeverity;
  title: string;
  message: string;
  /** Small, already-safe facts (ids, counts). Never secrets or raw payloads. */
  metadata?: Record<string, unknown>;
  at?: Date;
}

export interface AlertDelivery {
  /** True only when the sink CONFIRMED the alert was accepted. */
  delivered: boolean;
  error?: string | null;
}

export interface AlertSink {
  send(alert: Alert): Promise<AlertDelivery>;
}

export type AlertDispatch =
  | 'sent'
  | 'suppressed'
  | 'failed'
  | 'recovered'
  | 'recovery_failed'
  | 'noop';

/** Repeats of the same key within this window are collapsed into one alert. */
const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000;

let cooldownMs = DEFAULT_COOLDOWN_MS;
let sink: AlertSink | null = createEmailAlertSink();
const lastSentAt = new Map<string, number>();
const activeKeys = new Set<string>();

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Coerces arbitrary metadata to short, safe scalars. Drops non-scalars. */
function safeMetadata(metadata: Record<string, unknown> | undefined): Array<[string, string]> {
  if (!metadata) return [];
  const rows: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(metadata)) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'string') {
      rows.push([key, value.slice(0, 300)]);
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      rows.push([key, String(value)]);
    }
  }
  return rows;
}

function alertText(alert: Alert): string {
  const lines = [
    `${alert.title}`,
    '',
    alert.message,
    '',
    `Severity: ${alert.severity}`,
    `Time: ${(alert.at ?? new Date()).toISOString()}`,
    `Key: ${alert.key}`,
  ];
  for (const [key, value] of safeMetadata(alert.metadata)) {
    lines.push(`${key}: ${value}`);
  }
  lines.push('', 'This is an automated DRAFTOX operations alert.');
  return lines.join('\n');
}

function alertHtml(alert: Alert): string {
  const rows = safeMetadata(alert.metadata)
    .map(
      ([key, value]) =>
        `<tr><td style="padding:4px 12px 4px 0;color:#6b7280;vertical-align:top;">${escapeHtml(
          key,
        )}</td><td style="padding:4px 0;color:#111827;">${escapeHtml(value)}</td></tr>`,
    )
    .join('');
  return `<h2 style="margin:0 0 8px;font-size:16px;color:#0b1b33;">${escapeHtml(alert.title)}</h2>
<p style="margin:0 0 12px;white-space:pre-wrap;">${escapeHtml(alert.message)}</p>
<table style="border-collapse:collapse;font-size:13px;">
<tr><td style="padding:4px 12px 4px 0;color:#6b7280;">Severity</td><td style="padding:4px 0;color:#111827;">${escapeHtml(
    alert.severity,
  )}</td></tr>
<tr><td style="padding:4px 12px 4px 0;color:#6b7280;">Time</td><td style="padding:4px 0;color:#111827;">${escapeHtml(
    (alert.at ?? new Date()).toISOString(),
  )}</td></tr>
<tr><td style="padding:4px 12px 4px 0;color:#6b7280;">Key</td><td style="padding:4px 0;color:#111827;">${escapeHtml(
    alert.key,
  )}</td></tr>
${rows}
</table>
<p style="margin:16px 0 0;color:#6b7280;font-size:12px;">Automated DRAFTOX operations alert.</p>`;
}

/** Emails the store owner through the existing mailer. Never throws. */
export function createEmailAlertSink(): AlertSink {
  return {
    async send(alert: Alert): Promise<AlertDelivery> {
      if (!isMailerReady) {
        return { delivered: false, error: 'Email delivery is not configured on the server.' };
      }
      try {
        const result = await sendMail({
          to: ownerNotificationEmail,
          subject: `[DRAFTOX ${alert.severity.toUpperCase()}] ${alert.title}`,
          html: alertHtml(alert),
          text: alertText(alert),
        });
        return { delivered: result.accepted, error: result.error };
      } catch (err) {
        return { delivered: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

/** Registers a replacement sink (or null to disable delivery). */
export function registerAlertSink(next: AlertSink | null): void {
  sink = next;
}

/** Overrides the dedup cooldown (milliseconds). Used by tests. */
export function setAlertCooldown(ms: number): void {
  cooldownMs = Number.isFinite(ms) && ms >= 0 ? ms : DEFAULT_COOLDOWN_MS;
}

/** Resets all module state. Tests only. */
export function resetAlertState(): void {
  cooldownMs = DEFAULT_COOLDOWN_MS;
  sink = createEmailAlertSink();
  lastSentAt.clear();
  activeKeys.clear();
}

/** True when an alert for `key` is currently raised (last delivery succeeded). */
export function isAlertActive(key: string): boolean {
  return activeKeys.has(key);
}

/**
 * Raises an alert. Returns:
 *  - 'sent'       the sink confirmed delivery
 *  - 'suppressed' a repeat inside the cooldown window (no delivery attempted)
 *  - 'failed'     delivery was attempted but not confirmed
 */
export async function sendAlert(alert: Alert, now: number = Date.now()): Promise<AlertDispatch> {
  const at = alert.at ?? new Date(now);
  const previous = lastSentAt.get(alert.key);
  if (typeof previous === 'number' && now - previous < cooldownMs) {
    logger.warn('alert_suppressed', { key: alert.key, severity: alert.severity });
    return 'suppressed';
  }

  // Record the attempt up-front so a failing sink cannot cause a retry storm.
  lastSentAt.set(alert.key, now);

  const active = sink;
  if (!active) {
    logger.error('alert_no_sink', { key: alert.key });
    return 'failed';
  }

  try {
    const result = await active.send({ ...alert, at });
    if (result.delivered) {
      activeKeys.add(alert.key);
      logger.warn('alert_sent', { key: alert.key, severity: alert.severity });
      return 'sent';
    }
    logger.error('alert_delivery_failed', { key: alert.key, error: result.error ?? 'unknown' });
    return 'failed';
  } catch (err) {
    logger.error('alert_delivery_error', {
      key: alert.key,
      error: err instanceof Error ? err.message : String(err),
    });
    return 'failed';
  }
}

/**
 * Announces that a condition has cleared, exactly once, and only when it was
 * actually raised before. Clears the cooldown so a future re-occurrence alerts
 * immediately.
 */
export async function clearAlert(
  key: string,
  options?: { title?: string; message?: string },
  now: number = Date.now(),
): Promise<AlertDispatch> {
  const wasActive = activeKeys.delete(key);
  lastSentAt.delete(key);
  if (!wasActive) return 'noop';

  const active = sink;
  if (!active) return 'noop';

  const recovery: Alert = {
    key,
    severity: 'warning',
    title: options?.title ?? 'DRAFTOX condition recovered',
    message: options?.message ?? `The condition previously reported for "${key}" has cleared.`,
    at: new Date(now),
  };
  try {
    const result = await active.send(recovery);
    if (result.delivered) {
      logger.info('alert_recovered', { key });
      return 'recovered';
    }
    logger.error('alert_recovery_failed', { key, error: result.error ?? 'unknown' });
    return 'recovery_failed';
  } catch (err) {
    logger.error('alert_recovery_error', {
      key,
      error: err instanceof Error ? err.message : String(err),
    });
    return 'recovery_failed';
  }
}
