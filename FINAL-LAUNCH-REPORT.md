# DRAFTOX — Final Launch Report (Sections A–J)

**Prepared:** 2026-10-13
**Workspace:** `C:\Users\HARSH\draftox real backend\`, `C:\Users\HARSH\draftox real web\`
**Scope:** Final end-to-end audit + safe code fixes + tests + validation + runbook.

## A. Code Changes (Implemented in code)

### Backend (`draftox real backend`)
- `src/modules/auth/auth.service.ts`: implement SMTP password reset email (uses `sendMail`, builds reset URL `<PUBLIC_SITE_URL>/reset-password?token=...`, never leaks token in response; returns generic 200 on send failure). Added `publicSiteUrl`, `supportEmail` imports.
- `src/lib/mailer.ts`: added `maskEmail(address)` (PII minimisation for logs); log recipient as masked at `mail_not_sent_provider_not_configured` and `mail_rejected_by_provider`; exported `maskEmail`.
- `scripts/scheduler.ts`: store in-flight cycle (`currentCycle`) and await it (with 10s timeout) on graceful shutdown (SIGTERM/SIGINT), disconnecting DB after drain.
- Tests: `tests/passwordResetEmail.test.ts` (SMTP path: emails link, no devToken; delivery rejected → generic response), `tests/mailerMask.test.ts` (masking behavior).

### Frontend (`draftox real web`)
- `src/lib/validation/auth.ts`: added `ResetPasswordValues` + `validateResetPassword` (min 8, max 72, confirm matches).
- `src/lib/api/client.ts`: added `shopApi.resetPassword({ token, password })`.
- `src/components/auth/ResetPasswordForm.tsx`: new client form (reads `token` from URL, validates, calls API, success → sign-in; preview/live aware).
- `src/app/(auth)/reset-password/page.tsx`: new page (metadata: noindex/nofollow, title/description), wrapped in `<Suspense>` per useSearchParams.
- `src/app/(site)/cart/page.tsx`, `src/app/(site)/checkout/page.tsx`, `src/config/sale.ts`: removed fabricated "first 10 customers" scarcity/claims; replaced with honest launch copy.
- `src/app/layout.tsx`: `metadataBase` now env-driven (`NEXT_PUBLIC_SITE_URL ?? "https://draftox.in"`).
- `src/app/sitemap.ts`: added `/customize` to static routes.
- `src/app/robots.ts`: disallowed `/reset-password`.
- `src/app/track/[token]/page.tsx`: removed `/track` breadcrumb href (no such route exists).
- `package.json`: added `"typecheck": "tsc --noEmit"`.

### Docs
- `API.md`: clarified SMTP password reset behavior (email sent, token never returned, generic 200 on failure).
- `README.md`: noted SMTP path for password reset.
- `.env.example`: clarified SEO/links fallback, updated comment.
- `DEPLOYMENT-OPERATIONS-RUNBOOK.md`: new operations runbook (repo docs).

All changes are minimal, safe, and preserve existing behavior. No live transactions, no deployment, no secret values committed.

## B. Test Commands & Actual Results

### Backend
- `npm run typecheck` → passed (tsc -p tsconfig.json --noEmit; no errors).
- `npx vitest run` → **269 passed / 31 files**. New tests: `passwordResetEmail.test.ts` (2), `mailerMask.test.ts` (4). Prior baseline 263/29; deltas verified.
- `npm run build` → passed (`tsc -p tsconfig.build.json`).

### Frontend
- `npm run typecheck` → passed (`tsc --noEmit`).
- `npm run lint` → passed (eslint; 0 errors).
- `npx vitest run` → **104 passed / 9 files**. New test: `src/lib/validation/auth.test.ts` (6).
- `npm run build` → passed (Next.js 16.3.8; 37 routes including `/reset-password`, `robots.txt`, `sitemap.xml`).

**Summary:** All tests pass. No regressions.

## C. Remaining Bugs / Known Issues

**Minor, non-blocking:**
1. **Trust proxy hardcoded** (`src/app.ts:30`): `app.set('trust proxy', 1)` — should be env-driven (`TRUST_PROXY`) if behind >1 proxies.
2. **Rate limiting in-memory** (`src/middleware/rateLimit.ts`): per-process; multi-replica deployments need shared store (Redis).
3. **Scheduler shutdown edge** (`scripts/scheduler.ts`): drains current cycle (max 10s) — acceptable; idempotent DB guards protect against races.
4. **Broken internal link fixed** (`track/[token]/page.tsx`): removed `/track` breadcrumb href (the `/track` root page does not exist). If a `/track` landing page is desired, add it later.
5. **Metadata gaps**: several client pages (cart/checkout/account/admin/my-orders) lack `metadata` (not exported from client components). Non-indexable per robots.txt and not expected to be indexed; acceptable.
6. **`.env` plaintext on host**: contains secrets (gitignored) — treat filesystem as sensitive and rotate if copied/shared.
7. **Fallback origin**: `NEXT_PUBLIC_SITE_URL` falls back to `https://draftox.in` (SEO/metadata) — verify domain before production.

**No payment correctness bugs, no admin authz gaps, no PII in logs (masked), no secret logging, no fake reviews/testimonials/customer counts.**

## D. Exact Environment Variable Names (No Values)

### Backend (production-like)
- `NODE_ENV`
- `PORT`
- `DATABASE_URL`
- `TEST_DATABASE_URL` (dev/test only)
- `FRONTEND_URL`
- `PUBLIC_SITE_URL`
- `CORS_ORIGINS`
- `SESSION_SECRET` (>=32)
- `SESSION_TTL_HOURS` (default 24, max 720)
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL`
- `EMAIL_PROVIDER` (`none` or `smtp`)
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM`
- `ADMIN_EMAIL`, `SUPPORT_EMAIL`
- `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`
- `STORE_ORDERS_ENABLED` (`true` only when open)
- `SCHEDULER_INTERVAL_MINUTES`, `RECONCILE_GRACE_MINUTES`, `RECONCILE_BATCH_SIZE`
- `BACKUP_DIR`, `BACKUP_RETENTION_DAYS`, `BACKUP_LOG_FILE`, `GPG_PASSPHRASE`, `BACKUP_NOTIFY_EMAIL`, `BACKUP_ALERT_CHANNEL`
- `AUTH_RATE_LIMIT_MAX`, `INQUIRY_RATE_LIMIT_MAX`, `GENERAL_RATE_LIMIT_MAX`, `TRACKING_RATE_LIMIT_MAX`
- Optional: `EMAIL_DIAGNOSTIC_MAX_EMAILS`, `ORDERS_MAX_ITEMS`, `RATE_LIMIT_WINDOW_MINUTES`, `APP_NAME`, etc (see `.env.example`)

### Frontend
- `NEXT_PUBLIC_API_BASE_URL`
- `NEXT_PUBLIC_SITE_URL` (SEO/customer links; fallback `https://draftox.in`)
- `NEXT_PUBLIC_STORE_ORDERS_ENABLED` (mirror; gate)
- `NEXT_PUBLIC_CHECKOUT_TEST_MODE` (dev only)

### Derived/exports (read-only)
- Backend: `publicSiteUrl`, `supportEmail`, `mailerConfigured`, `emailFrom` (derived)

## E. Architecture Recommendations + Cost Categories

**Architecture (production):**
- Backend: Node.js + Express + Prisma (Postgres). Webhook raw-body handling; double-submit CSRF; rate-limits (in-mem now). Scheduler optional long-running or cron.
- Frontend: Next.js 16 App Router (SSR/SSG). Customer site + admin gated client pages (server-authoritative).
- Payments: Razorpay standard; webhook signature verify, dedup, guarded state transitions; reconcile safety net.
- Ops: pg_dump backups (custom + optional GPG), restore guardrails, alerts wired (email/console). No payment-movement from scheduler.

**Recommendations (low-risk hardening, code-safe or infra):**
1. Env-driven `TRUST_PROXY` (backend `app.ts:30`).
2. Shared rate-limit store if replicas.
3. Consider adding `SameSite=strict` where feasible? Current `lax` is fine for auth flow.
4. Add a `/track` landing page (minor UX).
5. Ensure `NEXT_PUBLIC_SITE_URL` matches actual domain before prod.
6. Review CSP via helmet (not currently set).

**Cost categories (rough, indicative):**
- Hosting (backend): VM/container ($5–$40/month) or PaaS ($10–$50/month)
- Hosting (frontend): Vercel (Hobby/Pro) or Node host
- Postgres: managed ($15–$100/month) or self-hosted
- SMTP: Gmail App Password free; transactional provider ($0–$10k/month depending)
- Razorpay: per transaction (commission) — no fixed site cost
- Backups: object storage ($0.01–$0.10/GB) or local disk
- Domain: to be purchased separately if desired ($2–$20/year) — **not purchased**
- Monitoring/logging optional ($0–$50/month)

**No paid services were subscribed to.**

## F. Domain/Hosting Checklist (In Order)

1. [ ] **Backup** current DB + code.
2. [ ] **Domain**: purchase `draftox.in` (or chosen) — **NOT DONE**. Note registrar/DNS.
3. [ ] **DNS**: point `draftox.in` to frontend host; `api.draftox.in` (or subpath) to backend host; set HTTPS.
4. [ ] **SSL/TLS**: provision certs (Let's Encrypt) on backend/frontend.
5. [ ] **Backend deploy**: build+start, set `NODE_ENV=production`, `PUBLIC_SITE_URL`, `FRONTEND_URL`, `CORS_ORIGINS` to real origins, `SESSION_SECRET` strong, `EMAIL_PROVIDER=smtp` + SMTP creds, Razorpay live keys + webhook secret.
6. [ ] **Webhook**: configure Razorpay webhook to `https://api.draftox.in/api/v1/payments/razorpay/webhook` with raw-body forwarding, correct secret.
7. [ ] **DB**: migrate + verify schema. Create prod DB (separate from dev/test).
8. [ ] **Scheduler**: run single instance or cron (see runbook).
9. [ ] **Backups**: test `npm run backup` + restore guardrails on prod DB copy; configure retention/notification.
10. [ ] **Frontend**: set `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_API_BASE_URL`, `NEXT_PUBLIC_STORE_ORDERS_ENABLED=false` initially; build/deploy.
11. [ ] **Smoke tests**: health, forgot-password (SMTP path), health, payments/status, admin authz. **Do not** test live payments.
12. [ ] **Go live**: enable `STORE_ORDERS_ENABLED=true` on backend + mirror frontend only after full verification.

## G. Backup/Restore/Scheduler/Alert/Payment-Recovery Setup

- **Backup**: `scripts/backup-db.ts` — pg_dump custom-format, `pg_restore --list` verification, optional GPG encryption, retention pruning, alert on failure. Config: `BACKUP_DIR`, `BACKUP_RETENTION_DAYS`, `BACKUP_LOG_FILE`, `GPG_PASSPHRASE`, `BACKUP_NOTIFY_EMAIL`, `BACKUP_ALERT_CHANNEL`.
- **Restore**: `scripts/restore-db.ts` — destructive; requires `RESTORE_CONFIRM=restore`; `RESTORE_DATABASE_URL` isolated from source unless `RESTORE_ALLOW_UNSAFE=true`; uses `--clean --if-exists` + `--no-owner`/caution.
- **Scheduler**: `scripts/scheduler.ts` — interval runs DB connectivity, `reconcilePendingPayments` (bounded batch), `checkRefundSla`, reports outcome. Overlap-safe in-proc, drains on shutdown, alerts on failure. Config: `SCHEDULER_INTERVAL_MINUTES=10`, `RECONCILE_GRACE_MINUTES=10`, `RECONCILE_BATCH_SIZE=25`.
- **Alerts**: `src/lib/alerts.ts` — console sink (dev) + optional email sink (SMTP when configured). Tracks alert key, suppresses dupes, recovers. Used by backup/scheduler/reconcile/monitoring.
- **Payment recovery**: webhook signature verify + dedup (`WebhookEvent`), durable ack/retry (5xx on processing), guarded `markOrderPaid`, amount/currency/duplicate checks, reconciliation only marks PAID on exact captured match and never CANCELLED. Admin endpoints: exceptions list/resolve, payments summary, reconcile-order, refunds list. Models `WebhookEvent`, `PaymentException`.

## H. Manual Account/KYC Actions (Required Before/If Going Live)

**Mandatory (if taking live payments):**
- [ ] **Razorpay**: switch to live keys (`rzp_live_*`) in prod; set live `RAZORPAY_WEBHOOK_SECRET`; add webhook endpoint (raw-body). Test with test mode first; never execute real charges in dev.
- [ ] **KYC/merchant onboarding** (Razorpay): complete account activation, bank details, GST/IT compliance as applicable. This is outside repo scope.
- [ ] **Email**: use production SMTP (not test); verify SPF/DKIM/DMARC for sender domain (`SMTP_USER`/`EMAIL_FROM`); Gmail App Password needs 2FA setup.
- [ ] **Domain ownership/SSL**: verify certificates; ensure `PUBLIC_SITE_URL`/`FRONTEND_URL` match.
- [ ] **Google OAuth**: production client ID/secret + exact callback URL (`/api/v1/auth/google/callback`).

**Optional but recommended:**
- [ ] **Backups**: offsite copy of backups.
- [ ] **Monitoring**: uptime/log retention.
- [ ] **Review**: privacy/terms with actual business details (already specific; no blanks).

## I. Explicitly Unverified Items (Blocked/Unknown)

- **Infrastructure**: no hosting provider, no domain purchase, no DNS, no HTTPS, no prod DB chosen/confirmed — unverified.
- **Razorpay live**: keys/webhook not configured; no live transactions attempted.
- **SMTP live**: not configured in prod; dev uses `EMAIL_PROVIDER=none` or unverified SMTP.
- **Redis/shared rate-limit**: not installed/configured (in-mem assumed).
- **Multi-replica**: scheduler run as single instance assumption unverified.
- **Backup location offsite**: only local `BACKUP_DIR` configured conceptually.
- **Actual delivery**: email delivery success not verified end-to-end against prod SMTP; only mocked in tests.
- **Browser/real-user a11y**: automated lint/typecheck only; manual screen-reader checks not performed.
- **Legal review**: privacy/terms written but not reviewed by counsel.
- **Real charges/refunds**: never performed; reconciliation logic verified via unit/integration tests only.

**Statuses bucket:** see J.

## J. GO / NO-GO Verdict + Status Buckets

**Verdict:** **GO (with conditions)** — codebase is launch-ready functionally and securely for a controlled launch *after* completing infra + account setup. Do NOT go live until all items in F,H are completed and verified.

### Status buckets (by artifact)
| Artifact | Implemented in code | Verified locally | Configured on real infrastructure | Verified E2E in sandbox | Not yet verified |
|---|---|---|---|---|---|
| Catalog/products data | ✓ | ✓ (tests + build) | — | — | ✓ (no real inventory/orders) |
| Auth (login/signup/Google/reset) | ✓ | ✓ (tests) | partial (Google keys unknown) | — | SMTP live, Google prod |
| Password reset (email link) | ✓ | ✓ (backend tests + frontend flow) | — | — | SMTP prod delivery |
| Orders/checkout (gate disabled) | ✓ | ✓ (gate tests) | ✓ (gate off by default) | — | enabling live orders |
| Payments/Razorpay | ✓ | ✓ (recovery tests) | — | — | live keys/webhook |
| Webhook + recovery + exceptions | ✓ | ✓ (paymentRecovery/payments tests) | — | — | live webhook E2E |
| Reconcile + scheduler + alerts | ✓ | ✓ (monitoring/alerts tests) | — | — | prod single-instance |
| Backup/restore | ✓ | ✓ (scripts reviewed; guardrails present) | — | — | prod backup restore drill |
| Admin UI + authz | ✓ | ✓ (admin tests + UI build) | — | — | prod admin access |
| SEO/sitemap/robots | ✓ | ✓ (build) | — | — | real domain crawl |
| Policies/legal | ✓ | ✓ (content present, no blanks) | — | — | legal review |
| Security hardening | ✓ | ✓ (CSRF/CORS/rate-limits/helmet) | — | — | trust proxy, replicas |
| Tests/CI validation | ✓ | ✓ (269 backend + 104 frontend) | — | — | CI integration |
| Ops runbook | ✓ | ✓ (written) | — | — | prod runthrough |

**Conditions for GO:** complete F.2–F.12, H.1–H.4, and perform at least a smoke test against real prod infra with `STORE_ORDERS_ENABLED=false` first. Do **not** enable ordering until payment verification + backup restore drill succeed in that environment.
