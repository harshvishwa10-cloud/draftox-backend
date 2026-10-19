import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Brevo transactional email HTTP API path in src/lib/mailer.ts.
 *
 * When BREVO_API_KEY is set, sendMail() must POST to
 * https://api.brevo.com/v3/smtp/email over HTTPS instead of touching outbound
 * SMTP (blocked on Render Free). Everything here mocks global.fetch - no real
 * network is used - and pins the truthful MailResult contract, the request
 * shape, and that the API key is NEVER logged.
 */

const API_KEY = 'xkeysib-test-do-not-log-0001';

// Capture logger output so we can prove the API key never leaks into logs.
const logs = vi.hoisted(() => ({ entries: [] as unknown[] }));
vi.mock('../src/lib/logger.js', () => ({
  logger: {
    info: (message: string, meta?: unknown) => logs.entries.push({ level: 'info', message, meta }),
    warn: (message: string, meta?: unknown) => logs.entries.push({ level: 'warn', message, meta }),
    error: (message: string, meta?: unknown) => logs.entries.push({ level: 'error', message, meta }),
  },
}));

type MailerModule = typeof import('../src/lib/mailer.js');

const fetchMock = vi.fn();

async function loadMailer(overrides: Record<string, string> = {}): Promise<MailerModule> {
  vi.resetModules();
  process.env.BREVO_API_KEY = API_KEY;
  process.env.EMAIL_PROVIDER = 'none';
  process.env.EMAIL_FROM = 'DRAFTox <harshvishwa10@gmail.com>';
  process.env.EMAIL_FROM_NAME = 'DRAFTOX';
  for (const [key, value] of Object.entries(overrides)) {
    process.env[key] = value;
  }
  return import('../src/lib/mailer.js');
}

const MAIL = {
  to: 'draftoxcustomersupport@gmail.com',
  subject: 'New contact enquiry',
  html: '<p>hello</p>',
  text: 'hello',
};

beforeEach(() => {
  fetchMock.mockReset();
});

afterEach(() => {
  logs.entries.length = 0;
  process.env.BREVO_API_KEY = '';
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe('Brevo mailer path (BREVO_API_KEY set)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
  });

  it('reports the brevo provider as ready in diagnostics', async () => {
    const mod = await loadMailer();
    const report = mod.diagnoseEmailConfig();
    expect(report.provider).toBe('brevo');
    expect(report.overall).toBe('ready');
    expect(report.checks.some((c) => c.key === 'BREVO_API_KEY' && c.present)).toBe(true);
  });

  it('POSTs the expected payload to the Brevo endpoint and returns the messageId on 201', async () => {
    const mod = await loadMailer();
    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ messageId: 'mid-brevo-1' }),
    });

    const result = await mod.sendMail(MAIL);

    expect(result).toEqual({ accepted: true, messageId: 'mid-brevo-1', error: null });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('https://api.brevo.com/v3/smtp/email');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['api-key']).toBe(API_KEY);
    expect(headers['content-type']).toBe('application/json');
    expect(headers.accept).toBe('application/json');

    const body = JSON.parse(init.body as string) as {
      sender: { email: string; name: string };
      to: Array<{ email: string }>;
      subject: string;
      htmlContent: string;
      textContent: string;
    };
    // Sender email is the BARE address parsed out of the "Name <email>" form.
    expect(body.sender).toEqual({ email: 'harshvishwa10@gmail.com', name: 'DRAFTOX' });
    expect(body.to).toEqual([{ email: MAIL.to }]);
    expect(body.subject).toBe(MAIL.subject);
    expect(body.htmlContent).toBe(MAIL.html);
    expect(body.textContent).toBe(MAIL.text);
  });

  it('takes precedence over SMTP even when EMAIL_PROVIDER=smtp is configured', async () => {
    const mod = await loadMailer({
      EMAIL_PROVIDER: 'smtp',
      SMTP_HOST: 'smtp.gmail.com',
      SMTP_PORT: '465',
      SMTP_USER: 'draftoxcustomersupport@gmail.com',
      SMTP_PASS: 'app-password',
    });
    fetchMock.mockResolvedValue({ ok: true, status: 201, json: async () => ({ messageId: 'mid-2' }) });

    const result = await mod.sendMail(MAIL);

    expect(result.accepted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns FAILED with the status and provider code on a non-2xx response', async () => {
    const mod = await loadMailer();
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ code: 'unauthorized', message: 'Key not found' }),
    });

    const result = await mod.sendMail(MAIL);

    expect(result.accepted).toBe(false);
    expect(result.messageId).toBeNull();
    expect(result.error).toContain('401');
    expect(result.error).toContain('unauthorized');
  });

  it('returns FAILED (never throws) when fetch rejects with a network error', async () => {
    const mod = await loadMailer();
    fetchMock.mockRejectedValue(new Error('fetch failed'));

    const result = await mod.sendMail(MAIL);

    expect(result.accepted).toBe(false);
    expect(result.messageId).toBeNull();
    expect(result.error).toContain('fetch failed');
  });

  it('returns FAILED when the request is aborted by the timeout signal', async () => {
    const mod = await loadMailer();
    const abort = Object.assign(new Error('The operation was aborted due to timeout'), {
      name: 'TimeoutError',
    });
    fetchMock.mockRejectedValue(abort);

    const result = await mod.sendMail(MAIL);

    expect(result.accepted).toBe(false);
    expect(result.error).toContain('aborted');
  });

  it('never calls fetch and reports a safe error when the recipient is empty', async () => {
    const mod = await loadMailer();

    const result = await mod.sendMail({ ...MAIL, to: '   ' });

    expect(result.accepted).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never logs the API key on either success or failure', async () => {
    const mod = await loadMailer();

    fetchMock.mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ messageId: 'm' }) });
    await mod.sendMail(MAIL);

    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ code: 'unauthorized', message: `bad key ${API_KEY}` }),
    });
    await mod.sendMail(MAIL);

    fetchMock.mockRejectedValueOnce(new Error('network down'));
    await mod.sendMail(MAIL);

    expect(logs.entries.length).toBeGreaterThan(0);
    expect(JSON.stringify(logs.entries)).not.toContain(API_KEY);
  });
});

describe('mailer with no transport configured', () => {
  it('is not ready and refuses to send when neither Brevo nor SMTP is set', async () => {
    vi.resetModules();
    process.env.BREVO_API_KEY = '';
    process.env.EMAIL_PROVIDER = 'none';
    const mod = await import('../src/lib/mailer.js');

    expect(mod.isMailerReady).toBe(false);
    const result = await mod.sendMail(MAIL);
    expect(result.accepted).toBe(false);
    expect(result.error).toContain('not configured');
  });
});
