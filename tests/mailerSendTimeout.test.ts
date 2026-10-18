import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * sendMail() must never hold an HTTP request beyond EMAIL_SEND_TIMEOUT_MS.
 * Render Free blocks outbound SMTP (25/465/587), so a Gmail transport would
 * otherwise hang for nodemailer's defaults (connect 2min, greeting 30s,
 * socket 10min) and the storefront's 15s AbortController would abort the
 * request with a bogus "Could not reach the server" even though the inquiry
 * was already saved. These tests pin the transport timeouts and the hard
 * race inside sendMail, using a mocked nodemailer - no network is touched.
 */

const transport = vi.hoisted(() => ({ sendMail: vi.fn() }));
const createTransport = vi.hoisted(() =>
  vi.fn((options: Record<string, unknown>) => {
    void options;
    return transport;
  }),
);

vi.mock('nodemailer', () => ({
  default: {
    createTransport: (options: Record<string, unknown>) => createTransport(options),
  },
}));

type MailerModule = typeof import('../src/lib/mailer.js');

async function loadMailer(overrides: Record<string, string> = {}): Promise<MailerModule> {
  vi.resetModules();
  process.env.EMAIL_PROVIDER = 'smtp';
  process.env.SMTP_HOST = 'smtp.gmail.com';
  process.env.SMTP_PORT = '465';
  process.env.SMTP_USER = 'draftoxcustomersupport@gmail.com';
  process.env.SMTP_PASS = 'test-app-password-0000';
  for (const [key, value] of Object.entries(overrides)) {
    process.env[key] = value;
  }
  return import('../src/lib/mailer.js');
}

const MAIL = {
  to: 'draftox0@gmail.com',
  subject: 'Timeout test',
  html: '<p>hello</p>',
  text: 'hello',
};

describe('sendMail: bounded delivery attempt', () => {
  beforeEach(() => {
    transport.sendMail.mockReset();
    createTransport.mockClear();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('applies EMAIL_SEND_TIMEOUT_MS to connect, greeting and socket timeouts', async () => {
    const mod = await loadMailer({ EMAIL_SEND_TIMEOUT_MS: '4000' });
    transport.sendMail.mockResolvedValue({ accepted: ['a@b.com'], messageId: 'mid-1' });

    await mod.sendMail(MAIL);

    expect(createTransport).toHaveBeenCalledTimes(1);
    const options = createTransport.mock.calls[0]![0];
    expect(options.connectionTimeout).toBe(4000);
    expect(options.greetingTimeout).toBe(4000);
    expect(options.socketTimeout).toBe(4000);
  });

  it('resolves truthfully when the provider accepts', async () => {
    const mod = await loadMailer();
    transport.sendMail.mockResolvedValue({ accepted: ['a@b.com'], messageId: 'mid-2' });

    const result = await mod.sendMail(MAIL);

    expect(result).toEqual({ accepted: true, messageId: 'mid-2', error: null });
  });

  it('resolves FAILED (never throws) when the transport rejects, e.g. SMTP Connection timeout', async () => {
    const mod = await loadMailer();
    transport.sendMail.mockRejectedValue(new Error('Connection timeout'));

    const result = await mod.sendMail(MAIL);

    expect(result.accepted).toBe(false);
    expect(result.messageId).toBeNull();
    expect(result.error).toBe('Connection timeout');
  });

  it('resolves FAILED within the bound when the transport hangs forever', async () => {
    const mod = await loadMailer({ EMAIL_SEND_TIMEOUT_MS: '1000' });
    transport.sendMail.mockImplementation(() => new Promise(() => undefined));

    const started = Date.now();
    const result = await mod.sendMail(MAIL);
    const elapsed = Date.now() - started;

    expect(result.accepted).toBe(false);
    expect(result.error).toContain('timed out after 1000ms');
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(5000);
  });

  it('never surfaces an unhandled rejection when a hung send rejects after the timeout', async () => {
    const mod = await loadMailer({ EMAIL_SEND_TIMEOUT_MS: '1000' });
    transport.sendMail.mockImplementation(
      () =>
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('late SMTP failure')), 50);
        }),
    );

    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const result = await mod.sendMail(MAIL);
      expect(result.accepted).toBe(false);
      // Give the late rejection time to fire and prove it was swallowed.
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});
