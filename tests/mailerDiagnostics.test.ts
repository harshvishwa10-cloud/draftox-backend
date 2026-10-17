import { afterEach, describe, expect, it, vi } from 'vitest';
import { diagnoseEmailConfig } from '../src/lib/mailer.js';

describe('email config diagnostics (presence-only, no secrets)', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('reports delivery disabled when EMAIL_PROVIDER is none (project default)', () => {
    const report = diagnoseEmailConfig();
    expect(report.provider).toBe('none');
    expect(report.overall).toBe('disabled');
    expect(report.checks.every((c) => typeof c.present === 'boolean')).toBe(true);
    expect(report.warnings.length).toBeGreaterThan(0);
  });

  it('never leaks values — checks carry only presence booleans and comments', () => {
    const report = diagnoseEmailConfig();
    for (const check of report.checks) {
      expect(Object.keys(check).filter((k) => k !== 'comment').sort()).toEqual(
        ['key', 'present', 'required'].sort(),
      );
      expect(check.present).toBeTypeOf('boolean');
      expect(check.required).toBeTypeOf('boolean');
    }
  });

  it('flags a fully configured Gmail setup as ready', async () => {
    vi.resetModules();
    process.env.EMAIL_PROVIDER = 'smtp';
    process.env.SMTP_HOST = 'smtp.gmail.com';
    process.env.SMTP_PORT = '465';
    process.env.SMTP_USER = 'draftoxcustomersupport@gmail.com';
    process.env.SMTP_PASS = 'abcdefghijklmnop';
    process.env.EMAIL_FROM = 'DRAFTox <draftoxcustomersupport@gmail.com>';
    process.env.PUBLIC_SITE_URL = 'https://draftox.in';

    const mod = await import('../src/lib/mailer.js');
    const report = mod.diagnoseEmailConfig();
    expect(report.provider).toBe('smtp');
    expect(report.overall).toBe('ready');
    expect(report.checks.filter((c) => c.required).every((c) => c.present)).toBe(true);
    expect(report.checks.some((c) => c.key === 'SUPPORT_EMAIL')).toBe(true);
  });

  it('flags incomplete SMTP config (missing SMTP_PASS) with the key name only', async () => {
    // Note: EMAIL_PROVIDER=smtp with an EMPTY SMTP_HOST/USER is already rejected
    // at startup by env.ts (clear hard error + process.exit). Diagnostics reach
    // the "incomplete" branch only for the settings env.ts does not gate on,
    // e.g. SMTP_PASS.
    vi.resetModules();
    process.env.EMAIL_PROVIDER = 'smtp';
    process.env.SMTP_HOST = 'smtp.gmail.com';
    process.env.SMTP_PORT = '587';
    process.env.SMTP_USER = 'draftoxcustomersupport@gmail.com';
    process.env.SMTP_PASS = '';

    const mod = await import('../src/lib/mailer.js');
    const report = mod.diagnoseEmailConfig();
    expect(report.provider).toBe('smtp');
    expect(report.overall).toBe('incomplete');
    const missing = report.checks.filter((c) => c.required && !c.present).map((c) => c.key);
    expect(missing).toEqual(['SMTP_PASS']);
    expect(report.warnings.some((w) => w.includes('incomplete'))).toBe(true);
  });

  it('warns when the From address differs from the Gmail SMTP user', async () => {
    vi.resetModules();
    process.env.EMAIL_PROVIDER = 'smtp';
    process.env.SMTP_HOST = 'smtp.gmail.com';
    process.env.SMTP_PORT = '587';
    process.env.SMTP_USER = 'draftoxcustomersupport@gmail.com';
    process.env.SMTP_PASS = 'abcdefghijklmnop';
    process.env.EMAIL_FROM = 'DRAFTox <someoneelse@gmail.com>';

    const mod = await import('../src/lib/mailer.js');
    const report = mod.diagnoseEmailConfig();
    expect(report.overall).toBe('ready');
    expect(report.warnings.some((w) => w.includes('EMAIL_FROM'))).toBe(true);
  });
});