// Setup file — executed by vitest before each test file module is imported.
import { parseDotEnv, resolveTestDatabaseUrl } from './helpers/testEnv.js';

const dotenv = parseDotEnv();

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = resolveTestDatabaseUrl(dotenv);
process.env.SESSION_SECRET = dotenv.SESSION_SECRET ?? 'test-session-secret-that-is-long-enough-0123456789';
process.env.FRONTEND_URL = dotenv.FRONTEND_URL ?? 'http://localhost:3000';
process.env.PUBLIC_SITE_URL = dotenv.PUBLIC_SITE_URL ?? 'http://localhost:3000';
process.env.CORS_ORIGINS = dotenv.CORS_ORIGINS ?? 'http://localhost:3000';
process.env.EMAIL_PROVIDER = 'none';
// Keep Brevo disabled by default regardless of the developer's local .env, so
// the mailer falls back to the EMAIL_PROVIDER=none / SMTP behavior every test
// expects. Brevo-specific tests set BREVO_API_KEY themselves and re-import.
process.env.BREVO_API_KEY = '';
// Pin the admin/support identity addresses so the developer's local .env cannot
// leak a conflicting value (e.g. SUPPORT_EMAIL = ADMIN_EMAIL) into the tests
// that assert the admin/support separation and the shipment-email support
// address. These match the documented code defaults in src/config/env.ts.
process.env.ADMIN_EMAIL = 'draftox0@gmail.com';
process.env.SUPPORT_EMAIL = 'draftoxcustomersupport@gmail.com';
// The ONLY full administrator is draftox0@gmail.com. The customer-support
// address is a SEPARATE, RESTRICTED support account (SUPPORT_EMAILS) that may
// only touch the public-request inbox — pinned here so every test file exercises
// the same single-admin + restricted-support policy as production.
process.env.ADMIN_EMAILS = 'draftox0@gmail.com';
process.env.SUPPORT_EMAILS = 'draftoxcustomersupport@gmail.com';
// Ensure Google OAuth stays disabled in tests regardless of local .env values.
process.env.GOOGLE_CLIENT_ID = '';
process.env.GOOGLE_CLIENT_SECRET = '';
process.env.GOOGLE_CALLBACK_URL = '';
// Keep Razorpay disabled for the default test env regardless of local .env
// values; tests/payments.test.ts enables it explicitly before importing the app.
process.env.RAZORPAY_KEY_ID = '';
process.env.RAZORPAY_KEY_SECRET = '';
process.env.RAZORPAY_WEBHOOK_SECRET = '';
// Keep Firebase Admin disabled by default regardless of local .env values.
// Firebase-specific tests mock the Admin SDK and/or set FIREBASE_AUTH_EMULATOR_HOST
// before importing the app.
process.env.FIREBASE_PROJECT_ID = '';
process.env.FIREBASE_CLIENT_EMAIL = '';
process.env.FIREBASE_PRIVATE_KEY = '';
process.env.FIREBASE_SERVICE_ACCOUNT_JSON = '';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '';
// Force the local-only ₹10 test-price override OFF by default, regardless of
// the developer's .env (which dotenv loads via src/config/env.ts). Tests that
// exercise the override set it back to 'true' themselves.
process.env.DEV_TEST_PRICE_ENABLED = 'false';
// Force the local-only free-shipping override OFF by default for the same
// reason; the dedicated override tests turn it on explicitly.
process.env.DEV_FREE_SHIPPING_ENABLED = 'false';
// Keep Redis out of the test path regardless of local .env values, so the
// rate-limiter uses its default in-memory store and the catalogue cache is a
// no-op (Redis is never a hard dependency; tests must not require it).
process.env.REDIS_URL = '';
// Keep the CSRF cookie host-only by default (no Domain attribute), regardless
// of the developer's local .env. The dedicated COOKIE_DOMAIN tests set it
// themselves before importing src/config/env.ts.
process.env.COOKIE_DOMAIN = '';
// Keep rate limits out of the way during tests.
process.env.RATE_LIMIT_MAX = '100000';
process.env.AUTH_RATE_LIMIT_MAX = '100000';
process.env.INQUIRY_RATE_LIMIT_MAX = '100000';
// Tests exercise the full order/payment flow, so ordering starts OPEN here,
// independent of the developer's local .env. tests/ordersDisabled.test.ts
// flips the pause flag on before importing the app to prove the server-side
// gate, so both gate states stay covered.
process.env.STORE_ORDERS_PAUSED = 'false';
