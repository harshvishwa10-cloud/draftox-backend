import 'dotenv/config';
import { z } from 'zod';
import { parseEmailList } from '../utils/normalize.js';

const optionalUrl = z
  .string()
  .trim()
  .refine((v) => v === '' || z.string().url().safeParse(v).success, {
    message: 'must be a valid URL when set',
  })
  .transform((v) => (v === '' ? undefined : v));

export const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    FRONTEND_URL: z.string().url('FRONTEND_URL must be a valid URL'),
    /**
     * Public base URL used to build customer-facing tracking links
     * (`<PUBLIC_SITE_URL>/track/<token>`). In production this MUST be the real
     * site origin (e.g. https://draftox.in). Falls back to FRONTEND_URL.
     */
    PUBLIC_SITE_URL: optionalUrl.optional(),
    CORS_ORIGINS: z.string().min(1, 'CORS_ORIGINS is required (comma separated origins)'),
    /**
     * Optional `Domain` attribute for the non-HttpOnly CSRF cookie ONLY. The
     * storefront JS must be able to read the double-submit token, so when the
     * frontend and API live on sibling subdomains (e.g. https://draftox.in and
     * https://api.draftox.in) the cookie has to be shared. Accepts ONLY a bare
     * domain with a leading dot (e.g. `.draftox.in`) — no scheme, path, port, or
     * whitespace. Unset/empty keeps the cookie host-only (existing behavior);
     * the HttpOnly session cookies are never affected by this value.
     */
    COOKIE_DOMAIN: z
      .string()
      .refine(
        (v) =>
          v === '' ||
          /^\.(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/.test(v),
        {
          message:
            'COOKIE_DOMAIN must be a bare domain like ".draftox.in" (leading dot; no scheme, path, port, or whitespace)',
        },
      )
      .transform((v) => (v === '' ? undefined : v))
      .optional(),
    SESSION_SECRET: z
      .string()
      .min(32, 'SESSION_SECRET must be at least 32 characters'),
    SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(168),
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    GOOGLE_CALLBACK_URL: optionalUrl.optional(),
    /**
     * Firebase Authentication (Admin SDK). All optional so the app still boots
     * without Firebase configured (used only during the migration window; the
     * server-side boundary prefers Firebase whenever it is fully configured).
     *
     * Provide EITHER the three discrete service-account values below OR a single
     * `FIREBASE_SERVICE_ACCOUNT_JSON` blob (JSON string). Never commit these and
     * never expose them to the frontend bundle.
     */
    FIREBASE_PROJECT_ID: z.string().trim().optional(),
    FIREBASE_CLIENT_EMAIL: z.string().trim().optional(),
    /** Service-account private key. Literal `\n` sequences are normalized at load. */
    FIREBASE_PRIVATE_KEY: z.string().optional(),
    /** Alternative to the three discrete values: the whole service-account JSON. */
    FIREBASE_SERVICE_ACCOUNT_JSON: z.string().optional(),
    /**
     * Firebase Auth emulator host (e.g. `127.0.0.1:9099`). Test/dev only; the
     * Admin SDK reads this standard variable directly. Never set in production.
     */
    FIREBASE_AUTH_EMULATOR_HOST: z.string().trim().optional(),
    /**
     * Lifetime of the server-managed Firebase session cookie, in days.
     * Firebase caps session cookies at 14 days. Default 5 days.
     */
    FIREBASE_SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(14).default(5),
    // The PRIMARY account permitted administrator access. Server-side only;
    // never trusted from the client. Authorization additionally requires a
    // Google/Firebase-verified email. Kept for backward compatibility; extra
    // admins are listed in ADMIN_EMAILS and the two are combined (UNION).
    // Do NOT point this at SUPPORT_EMAIL by replacing it — list SUPPORT_EMAIL in
    // ADMIN_EMAILS instead so both official accounts stay explicit.
    ADMIN_EMAIL: z.string().trim().min(3).default('draftox0@gmail.com'),
    /**
     * Additional authorized administrator emails, comma-separated
     * (e.g. `draftoxcustomersupport@gmail.com`). The authorized administrator
     * set is the UNION of `ADMIN_EMAIL` and every entry here — each entry must
     * match EXACTLY (case-insensitively); there is no domain/prefix wildcard, so
     * listing one address never authorizes other accounts on the same domain.
     * Every admin still requires a Google/Firebase-verified email at request
     * time. Empty/unset keeps the single-admin behaviour.
     */
    ADMIN_EMAILS: z.string().trim().optional(),
    RAZORPAY_KEY_ID: z.string().optional(),
    RAZORPAY_KEY_SECRET: z.string().optional(),
    RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
    // Delhivery (courier) integration placeholders. Live booking is disabled
    // until business approval + credentials exist (see src/modules/shipping).
    DELHIVERY_MODE: z.enum(['staging', 'production']).default('staging'),
    DELHIVERY_API_TOKEN: z.string().optional(),
    DELHIVERY_BASE_URL: optionalUrl.optional(),
    DELHIVERY_PICKUP_LOCATION: z.string().optional(),
    DELHIVERY_ENABLE_BOOKING: z.enum(['true', 'false']).default('false'),
    EMAIL_PROVIDER: z.enum(['none', 'smtp']).default('none'),
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().int().optional(),
    // The sending account. For Gmail this is the FULL address (e.g.
    // draftoxcustomersupport@gmail.com) — the sender of shipment emails. SMTP_USER
    // is unrelated to ADMIN_EMAIL: the admin account never sends or receives
    // customer mail, and the support account never gains admin rights.
    SMTP_USER: z.string().optional(),
    SMTP_PASS: z.string().optional(),
    // Optional override for the From header. Gmail requires From to match the
    // authenticated SMTP_USER; when unset the mailer falls back to SMTP_USER.
    EMAIL_FROM: z.string().optional(),
    /** Customer support address shown in emails + on the tracking page. Distinct from the admin account. */
    SUPPORT_EMAIL: z.string().trim().email().default('draftoxcustomersupport@gmail.com'),
    /**
     * Recipient of store-owner notifications for new public requests (contact /
     * product enquiry / support). Optional; falls back to ADMIN_EMAIL. This is a
     * RECIPIENT only — outbound mail is still sent from the SMTP/support account.
     */
    OWNER_NOTIFICATION_EMAIL: z.string().trim().email().optional(),
    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(15 * 60 * 1000),
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
    AUTH_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(15 * 60 * 1000),
    AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(20),
    INQUIRY_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60 * 60 * 1000),
    INQUIRY_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
    /** Public tracking endpoint is login-free, so it gets its own tighter limit. */
    TRACKING_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(15 * 60 * 1000),
    TRACKING_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(60),
    /**
     * Redis connection string (e.g. redis://:password@host:6379). Optional.
     * Only the PUBLIC catalogue list/detail responses are cached, with a short
     * TTL; every other query still reads PostgreSQL. When unset or unreachable
     * the cache silently falls back to direct database reads — the API never
     * fails because Redis is unavailable.
     */
    REDIS_URL: optionalUrl.optional(),
    /** Cache TTL in seconds for public catalog reads. */
    CACHE_TTL_SECONDS: z.coerce.number().int().min(1).max(24 * 60 * 60).default(60),
    /**
     * Return-request window in whole calendar days, measured from the VERIFIED
     * delivery timestamp. Server-side only — the browser can never extend it.
     */
    RETURN_WINDOW_DAYS: z.coerce.number().int().min(1).max(90).default(10),
    /**
     * Where return photos are stored on disk (private; never served by any
     * static mount). Defaults to <backend>/uploads/returns when unset.
     */
    RETURN_PHOTO_UPLOADS_DIR: z.string().trim().optional(),
    /**
     * Master ordering switch, controlled ONLY server-side. Set to `true` to
     * open the store for new orders; anything else (including unset) keeps
     * ordering disabled while the products are still in development.
     * The variable is read from environment configuration, so the browser can
     * never flip it. Missed/invalid values fail open to DISABLED on purpose.
     */
    STORE_ORDERS_ENABLED: z.enum(['true', 'false']).default('false'),
    /**
     * Local-development test-price switch. When `true` (and NODE_ENV is not
     * `production`) the 16-channel system is priced at a token ₹10 so a
     * developer can exercise the full order/payment/email path against a local
     * backend without spending money. It is IGNORED in production and is read
     * only server-side — it can never be enabled from the browser. Default off.
     */
    DEV_TEST_PRICE_ENABLED: z.enum(['true', 'false']).default('false'),
    /**
     * Local-development free-shipping switch. When `true` (and NODE_ENV is not
     * `production`) the delivery fee is always ₹0, so a developer can verify the
     * complete payable total for the token-priced system (₹10 + ₹0 = ₹10)
     * end to end. It is IGNORED in production and read only server-side — it can
     * never be enabled from the browser. Default off.
     */
    DEV_FREE_SHIPPING_ENABLED: z.enum(['true', 'false']).default('false'),
  })
  .superRefine((val, ctx) => {
    // Every configured administrator address must be a real email. Duplicates
    // across ADMIN_EMAIL and ADMIN_EMAILS are allowed (the set is a UNION).
    const adminEmailCandidates = [val.ADMIN_EMAIL, ...parseEmailList(val.ADMIN_EMAILS)];
    for (const candidate of adminEmailCandidates) {
      const trimmed = candidate.trim();
      if (!trimmed) continue;
      if (!z.string().email().safeParse(trimmed).success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['ADMIN_EMAILS'],
          message: `"${trimmed}" is not a valid administrator email address`,
        });
      }
    }

    const googlePieces: Array<[string, string | undefined]> = [
      ['GOOGLE_CLIENT_ID', val.GOOGLE_CLIENT_ID],
      ['GOOGLE_CLIENT_SECRET', val.GOOGLE_CLIENT_SECRET],
      ['GOOGLE_CALLBACK_URL', val.GOOGLE_CALLBACK_URL],
    ];
    const provided = googlePieces.filter(([, v]) => v !== undefined && v !== '');
    if (provided.length > 0 && provided.length < googlePieces.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Google OAuth is partially configured — provide all of ${googlePieces.map(([k]) => k).join(', ')} or none`,
      });
    }
    const razorpayPieces: Array<[string, string | undefined]> = [
      ['RAZORPAY_KEY_ID', val.RAZORPAY_KEY_ID],
      ['RAZORPAY_KEY_SECRET', val.RAZORPAY_KEY_SECRET],
    ];
    const razorpayProvided = razorpayPieces.filter(([, v]) => v !== undefined && v !== '');
    if (razorpayProvided.length > 0 && razorpayProvided.length < razorpayPieces.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Razorpay is partially configured — provide both ${razorpayPieces.map(([k]) => k).join(' and ')} or neither`,
      });
    }
    if (val.EMAIL_PROVIDER === 'smtp') {
      if (!val.SMTP_HOST || !val.SMTP_USER) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'EMAIL_PROVIDER=smtp requires SMTP_HOST and SMTP_USER',
        });
      }
    }

    const hasServiceAccountJson = Boolean(val.FIREBASE_SERVICE_ACCOUNT_JSON);
    const discrete = [val.FIREBASE_PROJECT_ID, val.FIREBASE_CLIENT_EMAIL, val.FIREBASE_PRIVATE_KEY];
    const discreteProvided = discrete.filter((v) => v !== undefined && v !== '');
    if (hasServiceAccountJson && discreteProvided.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Firebase is configured twice — provide EITHER FIREBASE_SERVICE_ACCOUNT_JSON OR all of FIREBASE_PROJECT_ID/FIREBASE_CLIENT_EMAIL/FIREBASE_PRIVATE_KEY, not both',
      });
    }
    if (
      !hasServiceAccountJson &&
      discreteProvided.length > 0 &&
      discreteProvided.length < discrete.length
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Firebase Admin is partially configured — provide all of FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY or none',
      });
    }
  });

export type Env = z.infer<typeof EnvSchema>;

function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    // eslint-disable-next-line no-console
    console.error(`Invalid environment configuration:\n${details}`);
    process.exit(1);
  }
  return parsed.data;
}

const env = loadEnv();

export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';

export const corsOrigins = env.CORS_ORIGINS.split(',')
  .map((o) => o.trim())
  .filter(Boolean);

export const googleOAuthConfigured = Boolean(
  env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_CALLBACK_URL,
);

/**
 * True only when Firebase Admin has usable credentials (a service-account JSON
 * blob or the full discrete set). When false, the Firebase auth routes stay
 * unavailable and the pre-existing session path remains the security boundary.
 * The emulator host alone does NOT count as configured.
 */
export const firebaseConfigured = Boolean(
  env.FIREBASE_SERVICE_ACCOUNT_JSON ||
    (env.FIREBASE_PROJECT_ID && env.FIREBASE_CLIENT_EMAIL && env.FIREBASE_PRIVATE_KEY),
);

/** Session-cookie lifetime (ms) for server-managed Firebase sessions. */
export const firebaseSessionTtlMs = env.FIREBASE_SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;

export const razorpayConfigured = Boolean(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET);

export const razorpayWebhookConfigured = Boolean(env.RAZORPAY_WEBHOOK_SECRET);

/**
 * Public origin used for customer-facing tracking links. Prefers an explicit
 * PUBLIC_SITE_URL and otherwise falls back to FRONTEND_URL. Never call the
 * tracking route on a hardcoded domain — always derive it from configuration.
 */
export const publicSiteUrl = (env.PUBLIC_SITE_URL ?? env.FRONTEND_URL).replace(/\/+$/, '');

/** True only when SMTP delivery is actually configured (provider + host + user). */
export const mailerConfigured =
  env.EMAIL_PROVIDER === 'smtp' && Boolean(env.SMTP_HOST && env.SMTP_USER);

export const supportEmail = env.SUPPORT_EMAIL;

/**
 * Where new-request notifications are sent (the store owner). Defaults to the
 * single authorized admin address. Outbound mail still leaves from the
 * SMTP/support sender; this only controls the recipient.
 */
export const ownerNotificationEmail = env.OWNER_NOTIFICATION_EMAIL ?? env.ADMIN_EMAIL;

/**
 * Master ordering switch. Defaults to DISABLED everywhere except the test
 * suite (tests intentionally exercise the full order flow, so setup-env.ts
 * sets `STORE_ORDERS_ENABLED=true` unless a test file overrides it).
 * Send no money and create no orders while this is false.
 */
export const storeOrdersEnabled = env.STORE_ORDERS_ENABLED === 'true';

/**
 * From header for outbound email (shipment notifications). Defaults to the
 * authenticated SMTP sender so Gmail's From-must-match rule is satisfied
 * out of the box; ultimately falls back to the support address.
 */
export const emailFrom = env.EMAIL_FROM ?? env.SMTP_USER ?? supportEmail;

/**
 * True only when the Delhivery credentials a live booking would need are
 * present. Absence is expected: booking stays unavailable and shipment details
 * are recorded manually by an admin instead.
 */
export const delhiveryConfigured = Boolean(
  env.DELHIVERY_API_TOKEN && env.DELHIVERY_PICKUP_LOCATION,
);

export { env };
