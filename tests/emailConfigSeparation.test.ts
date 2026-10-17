import { describe, expect, it, vi } from 'vitest';
import { SUPPORT_EMAIL } from './helpers/admin.js';

const ADMIN_EMAIL = 'draftox0@gmail.com';

describe('admin account vs support/shipment sender separation', () => {
  it('both official accounts are authorized admins when their email is verified', async () => {
    const { effectiveRole } = await import('../src/modules/auth/authorization.js');
    // Both configured addresses (ADMIN_EMAIL + ADMIN_EMAILS) are authorized.
    expect(effectiveRole({ email: ADMIN_EMAIL, emailVerified: true })).toBe('ADMIN');
    expect(effectiveRole({ email: SUPPORT_EMAIL, emailVerified: true })).toBe('ADMIN');
    // Verification is still mandatory for both.
    expect(effectiveRole({ email: ADMIN_EMAIL, emailVerified: false })).toBe('CUSTOMER');
    expect(effectiveRole({ email: SUPPORT_EMAIL, emailVerified: false })).toBe('CUSTOMER');
  });

  it('config keeps admin = draftox0@gmail.com and support = draftoxcustomersupport@gmail.com as distinct addresses', async () => {
    const mod = await import('../src/config/env.js');
    expect(mod.env.ADMIN_EMAIL.toLowerCase()).toBe(ADMIN_EMAIL);
    expect(mod.env.SUPPORT_EMAIL.toLowerCase()).toBe(SUPPORT_EMAIL);
    expect(mod.env.ADMIN_EMAIL.toLowerCase()).not.toBe(mod.env.SUPPORT_EMAIL.toLowerCase());
  });

  it('the outbound sender defaults to the support SMTP_USER account — never the admin email', async () => {
    vi.resetModules();
    process.env.EMAIL_PROVIDER = 'smtp';
    process.env.SMTP_HOST = 'smtp.gmail.com';
    process.env.SMTP_PORT = '465';
    process.env.SMTP_USER = SUPPORT_EMAIL;
    process.env.SMTP_PASS = 'test-app-password-0000';
    delete process.env.EMAIL_FROM;

    const { emailFrom } = await import('../src/config/env.js');
    expect(emailFrom.toLowerCase().includes(SUPPORT_EMAIL)).toBe(true);
    expect(emailFrom.toLowerCase()).not.toContain(ADMIN_EMAIL);
  });

  it('honors an explicit EMAIL_FROM that matches the support sender', async () => {
    vi.resetModules();
    process.env.EMAIL_PROVIDER = 'smtp';
    process.env.SMTP_HOST = 'smtp.gmail.com';
    process.env.SMTP_PORT = '465';
    process.env.SMTP_USER = SUPPORT_EMAIL;
    process.env.SMTP_PASS = 'test-app-password-0000';
    process.env.EMAIL_FROM = `DRAFTox <${SUPPORT_EMAIL}>`;

    const { emailFrom } = await import('../src/config/env.js');
    expect(emailFrom.toLowerCase()).toContain(SUPPORT_EMAIL);
    expect(emailFrom.toLowerCase()).not.toContain(ADMIN_EMAIL);
  });
});