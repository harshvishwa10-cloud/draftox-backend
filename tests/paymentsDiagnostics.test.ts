import { afterEach, describe, expect, it, vi } from 'vitest';
import { diagnosePaymentsConfig } from '../src/modules/payments/payments.diagnostics.js';

describe('payments config diagnostics (presence-only, no secrets)', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('reports disabled when Razorpay keys are absent (project default)', () => {
    const report = diagnosePaymentsConfig();
    expect(report.mode).toBe('not-configured');
    expect(report.overall).toBe('disabled');
    expect(report.razorpayConfigured).toBe(false);
    expect(report.webhookConfigured).toBe(false);
    expect(report.checks.every((c) => typeof c.present === 'boolean')).toBe(true);
    expect(report.warnings.length).toBeGreaterThan(0);
  });

  it('never leaks values — checks carry only presence booleans and comments', () => {
    const report = diagnosePaymentsConfig();
    for (const check of report.checks) {
      expect(Object.keys(check).filter((k) => k !== 'comment').sort()).toEqual(
        ['key', 'present', 'required'].sort(),
      );
      expect(check.present).toBeTypeOf('boolean');
      expect(check.required).toBeTypeOf('boolean');
    }
  });

  it('flags a fully configured test-mode setup (keys + webhook secret) as ready', async () => {
    vi.resetModules();
    process.env.RAZORPAY_KEY_ID = 'rzp_test_0123456789abcdef';
    process.env.RAZORPAY_KEY_SECRET = 'qwerasdfzxcvtyui';
    process.env.RAZORPAY_WEBHOOK_SECRET = 'whsec_somevalue';

    const mod = await import('../src/modules/payments/payments.diagnostics.js');
    const report = mod.diagnosePaymentsConfig();
    expect(report.mode).toBe('test');
    expect(report.overall).toBe('ready');
    expect(report.razorpayConfigured).toBe(true);
    expect(report.webhookConfigured).toBe(true);
    expect(report.checks.filter((c) => c.required).every((c) => c.present)).toBe(true);
    expect(report.warnings.length).toBe(0);
  });

  it('flags incomplete config when the webhook secret is missing (keys present)', async () => {
    vi.resetModules();
    process.env.RAZORPAY_KEY_ID = 'rzp_test_0123456789abcdef';
    process.env.RAZORPAY_KEY_SECRET = 'qwerasdfzxcvtyui';
    process.env.RAZORPAY_WEBHOOK_SECRET = '';

    const mod = await import('../src/modules/payments/payments.diagnostics.js');
    const report = mod.diagnosePaymentsConfig();
    expect(report.mode).toBe('test');
    expect(report.overall).toBe('incomplete');
    expect(report.webhookConfigured).toBe(false);
    const missing = report.checks.filter((c) => c.required && !c.present).map((c) => c.key);
    expect(missing).toEqual(['RAZORPAY_WEBHOOK_SECRET']);
    expect(report.warnings.some((w) => w.includes('RAZORPAY_WEBHOOK_SECRET'))).toBe(true);
  });

  it('warns when test keys are used in production', async () => {
    vi.resetModules();
    process.env.NODE_ENV = 'production';
    process.env.RAZORPAY_KEY_ID = 'rzp_test_0123456789abcdef';
    process.env.RAZORPAY_KEY_SECRET = 'qwerasdfzxcvtyui';
    process.env.RAZORPAY_WEBHOOK_SECRET = 'whsec_somevalue';

    const mod = await import('../src/modules/payments/payments.diagnostics.js');
    const report = mod.diagnosePaymentsConfig();
    expect(report.mode).toBe('test');
    expect(report.overall).toBe('ready');
    expect(report.warnings.some((w) => w.includes('NODE_ENV=production'))).toBe(true);
  });

  it('warns when live keys are used outside production', async () => {
    vi.resetModules();
    process.env.NODE_ENV = 'development';
    process.env.RAZORPAY_KEY_ID = 'rzp_live_0123456789abcdef';
    process.env.RAZORPAY_KEY_SECRET = 'qwerasdfzxcvtyui';
    process.env.RAZORPAY_WEBHOOK_SECRET = 'whsec_somevalue';

    const mod = await import('../src/modules/payments/payments.diagnostics.js');
    const report = mod.diagnosePaymentsConfig();
    expect(report.mode).toBe('live');
    expect(report.overall).toBe('ready');
    expect(report.warnings.some((w) => w.includes('outside production'))).toBe(true);
  });

  it('calls out a malformed key id instead of guessing the mode', async () => {
    vi.resetModules();
    process.env.RAZORPAY_KEY_ID = 'rzp_demo_0123456789abcdef';
    process.env.RAZORPAY_KEY_SECRET = 'qwerasdfzxcvtyui';
    process.env.RAZORPAY_WEBHOOK_SECRET = '';

    const mod = await import('../src/modules/payments/payments.diagnostics.js');
    const report = mod.diagnosePaymentsConfig();
    expect(report.mode).toBe('not-configured');
    expect(report.warnings.some((w) => w.includes('rzp_test_'))).toBe(true);
  });
});