# DRAFTox Backend

Production-ready REST API for DRAFTox (website development, logo & brand identity, digital products, and DRAFTox Home Automation).

**Stack:** Node.js · Express 5 · TypeScript · PostgreSQL · Prisma · Zod · bcrypt · Google OAuth (`google-auth-library`)

---

## Features

- Email/password registration and login with secure, revocable DB-backed sessions (HttpOnly cookies)
- Google OAuth sign-in (official ID-token verification, verified-email matching, secure account linking)
- Password reset with expiring, single-use, hashed tokens (honest dev-mode response when no email provider is configured)
- Contact, product-inquiry and support-request APIs (inquiries only — never fake orders)
- Public product API (published products only; pagination + search)
- Helmet, rate limiting, controlled CORS with credentials, CSRF double-submit protection, centralized error handling, graceful shutdown

## Setup

### 1. Requirements

- Node.js ≥ 20
- PostgreSQL ≥ 14 running locally or remotely

### 2. Install

```bash
cd "draftox real backend"
npm install
```

### 3. Environment

```bash
cp .env.example .env
```

Edit `.env`:

| Variable | Required | Description |
| --- | --- | --- |
| `DATABASE_URL` | yes | PostgreSQL connection string, e.g. `postgresql://USER:PASS@localhost:5432/draftox_backend?schema=public` |
| `FRONTEND_URL` | yes | The Next.js origin, e.g. `http://localhost:3000` |
| `CORS_ORIGINS` | yes | Comma-separated allowed origins (no wildcards with credentials) |
| `SESSION_SECRET` | yes | ≥ 32 random chars — `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` |
| `PORT` | no | Default `4000` |
| `NODE_ENV` | no | `development` \| `production` \| `test` |
| `SESSION_TTL_HOURS` | no | Session lifetime, default `168` (7 days) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_CALLBACK_URL` | for Google sign-in | All three or none |
| `EMAIL_PROVIDER` | no | `none` (default) or `smtp` (delivery not yet implemented — resets stay dev-mode/503) |

Create the database (if it does not exist):

```sql
CREATE DATABASE draftox_backend;
```

### 4. Migrate + seed

Development (creates tables, may prompt; never use in production):

```bash
npm run prisma:generate
npm run prisma:migrate    # prisma migrate dev — local development only
npm run prisma:seed       # seeds DRAFTox Home Automation as an UNPUBLISHED draft
```

Production (apply already-committed migrations only; never resets data):

```bash
npm run prisma:generate
npm run prisma:deploy     # prisma migrate deploy — safe, non-destructive
```

Run `prisma:deploy` against the production database as a deliberate release step
before starting the new server build. Take a database backup first (see below).

The seed deliberately sets no price, no certifications, no warranty and `availability=UNKNOWN`. Publish and fill in verified details only after they are confirmed.

### 5. Run

```bash
npm run dev               # http://localhost:4000  (hot reload)
# or
npm run build && npm start
```

Health check: `GET http://localhost:4000/api/v1/health`

### 6. Tests / checks

```bash
npm run typecheck
npm test                  # vitest + supertest against a dedicated *_test database
```

Tests derive a test database from `DATABASE_URL` by appending `_test` (override with `TEST_DATABASE_URL`), run `prisma migrate deploy` and seed automatically.

## Operations

Payment reliability and durability are documented and scripted, but **not yet
running in production** — they require hosting that is not part of this repo:

- `npm run scheduler` — long-running worker that periodically reconciles pending
  online payments and checks refund/database/backup alerts (`scripts/scheduler.ts`).
- `npm run backup` — verified `pg_dump` backup with optional GPG encryption and
  retention pruning (`scripts/backup-db.ts`); restore via `scripts/restore-db.ts`.
- Alerting (webhook failures, unresolved exceptions, refunds past the 24-hour goal,
  reconciliation/backup failures, DB connectivity) emails the owner through the
  existing mailer; delivery is fail-safe and never blocks a payment.

See **[OPERATIONS.md](OPERATIONS.md)** for the full runbook (worker hosting,
backup/restore checklist, RPO/RTO targets, alerting table, refund SLA).

## Google OAuth setup

1. In [Google Cloud Console](https://console.cloud.google.com/apis/credentials) create an **OAuth 2.0 Client ID** (Web application).
2. Authorized redirect URI (exact match):
   - Production: `https://api.yourdomain.com/api/v1/auth/google/callback`
   - Development: `http://localhost:4000/api/v1/auth/google/callback`
3. Put the client ID, secret and callback URL in `.env` (all three or none).
4. Flow: frontend redirects the user to `GET /api/v1/auth/google` → Google → `GET /api/v1/auth/google/callback` → session cookie set → browser redirected to `{FRONTEND_URL}/auth/callback?status=success` (or `?status=error&reason=...`).

Only Google-verified emails are trusted; identities are matched by Google subject ID first, then by verified email for secure linking. Google tokens are never stored.

## Frontend integration

- Backend base URL for the Next.js app: `http://localhost:4000` (dev) / your production API origin.
- Send `credentials: 'include'` (fetch) on all authenticated calls.
- On every response the server sets a readable `draftox_csrf` cookie. Echo it back as the `X-CSRF-Token` header on all `POST` requests (login included).
- Allowed origins are configured via `CORS_ORIGINS`; wildcard + credentials is never used.
- After `POST /auth/logout`, drop any cached user state. Sessions are invalidated server-side.
- Password reset (email configured): with Brevo (`BREVO_API_KEY`) or SMTP (`EMAIL_PROVIDER=smtp` plus `SMTP_HOST`/`SMTP_USER`) the handler emails a single-use link to `<PUBLIC_SITE_URL>/reset-password?token=...`; the token is never returned in the HTTP response.
- Password reset (email not configured): non-test environments (development, staging, production) never return a reset token — the endpoint responds with a safe `503` service-unavailable error. A `devToken` is returned **only** when `NODE_ENV=test` (automated tests), alongside a message that no email was sent.

## Project layout

```
prisma/schema.prisma      # User, Session, PasswordResetToken, Product,
                          # ContactInquiry, ProductInquiry, SupportRequest
prisma/seed.ts            # DRAFTox Home Automation (DRAFT, price null)
src/app.ts                # Express app: helmet, CORS, cookies, CSRF, routes
src/index.ts              # bootstrap + graceful shutdown
src/config/env.ts         # validated environment
src/middleware/           # auth, csrf, rate limits, validation, errors
src/modules/              # auth, contact, product-inquiries, support, products, health
src/schemas/              # Zod schemas (strict — mass assignment rejected)
tests/                    # vitest + supertest
```

Full endpoint contract with examples: [API.md](./API.md).

## Security notes

- Passwords: bcrypt (12 rounds). Plaintext never stored or logged.
- Sessions: random token, SHA-256 hashed in the DB, HttpOnly + SameSite=Lax (+ Secure in production) cookie; logout and password reset invalidate server-side.
- CSRF: double-submit token + Origin check on state-changing requests.
- Rate limits: global, stricter on `/auth/*`, and on inquiry endpoints.
- Errors: consistent JSON, no stack traces or DB errors leaked; malformed JSON → 400.
- `.env` is gitignored; only `.env.example` with placeholders is committed.

## Notes / boundaries

- Product inquiries are **not orders**. No payment provider is integrated; nothing is ever marked PAID or CONFIRMED.
- No public admin endpoints exist. If added later, every admin route must require an authenticated `ADMIN` role.
- SMTP email delivery is stubbed: with `EMAIL_PROVIDER=smtp` the reset endpoint honestly returns 503 until delivery is implemented.
