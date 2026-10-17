import {
  env,
  isProduction,
  isTest,
  razorpayConfigured,
  razorpayWebhookConfigured,
} from '../../config/env.js';
import { logger } from '../../lib/logger.js';

export interface PaymentsConfigCheck {
  /** Env key name. No values are ever reported — only presence. */
  key: string;
  required: boolean;
  present: boolean;
  comment: string;
}

export interface PaymentsConfigDiagnosis {
  mode: 'test' | 'live' | 'not-configured';
  /** ready: keys + webhook present; incomplete: keys present but webhook missing; disabled: no keys. */
  overall: 'ready' | 'incomplete' | 'disabled';
  razorpayConfigured: boolean;
  webhookConfigured: boolean;
  checks: PaymentsConfigCheck[];
  warnings: string[];
}

function detectMode(keyId: string): 'test' | 'live' | null {
  if (keyId.startsWith('rzp_test_')) return 'test';
  if (keyId.startsWith('rzp_live_')) return 'live';
  return null;
}

/**
 * Reports whether Razorpay is wired up — PRESENCE only, never values, so it is
 * safe to log at startup. RAZORPAY_KEY_SECRET / RAZORPAY_WEBHOOK_SECRET appear
 * solely as present/absent booleans. Used by `logPaymentsDiagnostics()` and
 * unit tests. Detects the classic live-mode mistakes: test keys in production,
 * live keys outside production, an unset webhook secret.
 */
export function diagnosePaymentsConfig(): PaymentsConfigDiagnosis {
  const keyId = (env.RAZORPAY_KEY_ID ?? '').trim();
  const keySecret = (env.RAZORPAY_KEY_SECRET ?? '').trim();
  const webhookSecret = (env.RAZORPAY_WEBHOOK_SECRET ?? '').trim();

  const checks: PaymentsConfigCheck[] = [
    { key: 'RAZORPAY_KEY_ID', required: true, present: keyId.length > 0, comment: '' },
    {
      key: 'RAZORPAY_KEY_SECRET',
      required: true,
      present: keySecret.length > 0,
      comment: 'server-side only',
    },
    {
      key: 'RAZORPAY_WEBHOOK_SECRET',
      required: true,
      present: webhookSecret.length > 0,
      comment: 'required to verify payment confirmations',
    },
  ];

  if (!razorpayConfigured) {
    return {
      mode: 'not-configured',
      overall: 'disabled',
      razorpayConfigured: false,
      webhookConfigured: razorpayWebhookConfigured,
      checks,
      warnings: [
        'Razorpay is NOT configured (missing RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET) — ' +
          'the checkout stays disabled and order creation returns 503. ' +
          'Set both keys to enable test-mode payments (see .env.example).',
        ...(razorpayWebhookConfigured
          ? [
              'RAZORPAY_WEBHOOK_SECRET is set but the keys are not; webhooks cannot be ' +
                'signed or routed until the keys are configured.',
            ]
          : []),
      ],
    };
  }

  const mode = detectMode(keyId);
  if (mode === null) {
    return {
      mode: 'not-configured',
      overall: 'incomplete',
      razorpayConfigured: true,
      webhookConfigured: razorpayWebhookConfigured,
      checks,
      warnings: [
        'RAZORPAY_KEY_ID does not look like a Razorpay key — it should start with ' +
          'rzp_test_ or rzp_live_. Please re-check the key from the Razorpay Dashboard.',
      ],
    };
  }

  const warnings: string[] = [];
  if (mode === 'test' && isProduction) {
    warnings.push(
      'Razorpay is using TEST keys while NODE_ENV=production — real customers cannot be ' +
        'charged and live mode will not work. Switch to rzp_live_ keys for production.',
    );
  } else if (mode === 'live' && !isProduction) {
    warnings.push(
      'Razorpay is using LIVE keys outside production — a misconfiguration here could ' +
        'charge real customers. Use rzp_test_ keys for development and testing.',
    );
  }

  if (!razorpayWebhookConfigured) {
    warnings.push(
      'RAZORPAY_WEBHOOK_SECRET is empty — payment confirmations cannot be verified, the ' +
        'webhook returns 503, and order status will not auto-update. Copy the webhook ' +
        'secret from the Razorpay Dashboard and set the webhook URL to ' +
        `${env.PUBLIC_SITE_URL}/api/v1/payments/razorpay/webhook`,
    );
  }

  return {
    mode,
    overall: razorpayWebhookConfigured ? 'ready' : 'incomplete',
    razorpayConfigured: true,
    webhookConfigured: razorpayWebhookConfigured,
    checks,
    warnings,
  };
}

/** Logs presence-only startup diagnostics. Skipped under vitest whose env is synthetic. */
export function logPaymentsDiagnostics(): void {
  if (isTest) return;
  const report = diagnosePaymentsConfig();
  if (report.overall === 'ready') {
    logger.info('payments_ready', { mode: report.mode, webhook: report.webhookConfigured });
  } else if (report.razorpayConfigured) {
    logger.warn('payments_incomplete', {
      mode: report.mode,
      missing: report.checks.filter((c) => c.required && !c.present).map((c) => c.key),
    });
  } else {
    logger.warn('payments_disabled');
  }
  for (const warning of report.warnings) {
    logger.warn('payments_config_hint', { message: warning });
  }
}