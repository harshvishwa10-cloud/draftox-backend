# DRAFTOX — Deployment & Operations Runbook

**Status:** Operational for a self-hostable deployment. This document is informational only. No domain was purchased, no deployment was performed, and no live transactions were executed as part of this run.

## 1. Goals & Guardrails
- Orders are open by default; pause deliberately when needed (`STORE_ORDERS_PAUSED=true`, `NEXT_PUBLIC_STORE_ORDERS_ENABLED=false`).
- Never expose secrets in logs. Backup/restore are destructive — require explicit confirmation (`RESTORE_CONFIRM=restore`).
- Password reset with SMTP emails a single-use link (`<PUBLIC_SITE_URL>/reset-password?token=...`) and never returns the token.
- Scheduler is idempotent across processes, overlap-safe within a process.
- Razorpay webhook requires valid HMAC signature; events are deduplicated (by event ID or body hash); provider retries get 5xx.
- All payment/order-mutating operations are server-authoritative. Admin endpoints require admin authz.

## 2. Infrastructure Requirements
- Node.js (LTS). Two apps: backend on port 4000 (dev), frontend on 3000 (dev).
- PostgreSQL (managed or self-hosted). Separate databases for dev/test/prod recommended.
- SMTP provider (Gmail App Password recommended for simplicity) or an SMTP relay.
- Redis (optional): not required by the current implementation; rate-limits are in-memory (per-process). If running multiple backend replicas, use a shared rate-limit store (documented recommendation).
- Object storage / backup location for `pg_dump` custom-format backups (default `./backups/`).
- Hosting for backend (VM/container/Node host), frontend (Vercel/Node/NGINX static+SSR proxy). **No deployment manifests are committed** to the repo.

## 3. Environment Variables

### Backend (`C:\Users\HARSH\draftox real backend\.env`)
See `.env.example` for exhaustive list. Minimum safe production-like set:
- `NODE_ENV=production`
- `PORT=4000`
- `DATABASE_URL` (prod)
- `FRONTEND_URL` + `PUBLIC_SITE_URL` (customer-facing origin, e.g. `https://draftox.in`)
- `CORS_ORIGINS` = allowed origins (comma-separated, no `*` with credentials)
- `SESSION_SECRET` (>=32 chars; **do not** use placeholder in production)
- `SESSION_TTL_HOURS` (max 720)
- `EMAIL_PROVIDER=smtp` or `none` (smtp required for emails)
- SMTP: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM` (if not default)
- `ADMIN_EMAIL=draftox0@gmail.com`, `SUPPORT_EMAIL=draftoxcustomersupport@gmail.com`
- `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`
- `STORE_ORDERS_PAUSED=false` (set `true` only to pause ordering)
- `SCHEDULER_INTERVAL_MINUTES=10`, `RECONCILE_GRACE_MINUTES=10`, `RECONCILE_BATCH_SIZE=25`
- `BACKUP_DIR=./backups`, `BACKUP_RETENTION_DAYS=7`, `BACKUP_LOG_FILE=./logs/backup.log`, optional `GPG_PASSPHRASE`, `BACKUP_NOTIFY_EMAIL`, `BACKUP_ALERT_CHANNEL`
- `TRUST_PROXY=1` (overridable if behind >1 proxies; not present — see recommendation)

### Frontend (`C:\Users\HARSH\draftox real web\.env.local`)
- `NEXT_PUBLIC_API_BASE_URL=https://api.example.com/api/v1` (or your backend origin + `/api/v1`)
- `NEXT_PUBLIC_SITE_URL=https://draftox.in` (drives metadataBase/sitemap/robots; also customer links)
- `NEXT_PUBLIC_STORE_ORDERS_ENABLED=false` (mirror of backend; can stay false as a final guard)

**Note:** Google OAuth is backend-only. Razorpay publishable `keyId` is returned by backend endpoint (`/api/v1/payments/razorpay/status` / `/order`) after verification.

## 4. Database
- Migrations: `npx prisma migrate deploy` (tests do this; use in prod after backup)
- Seed: `npm run seed` (idempotent; adds catalog products only)
- Backup: `npm run backup` (pg_dump custom-format; validates; optional GPG; prunes by retention; raises alerts on failure)
- Restore: `npm run restore` — **DESTRUCTIVE**. Requires `RESTORE_CONFIRM=restore` and a dedicated `RESTORE_DATABASE_URL` whose DB name is not the source unless `RESTORE_ALLOW_UNSAFE=true`. Refuses to restore to a DB name matching the source without explicit override.

## 5. Running in Production
1. **Backup first**: run backup against target DB; verify the `.dump` (and optional `.dump.gpg`) file.
2. **Migrate**: `prisma migrate deploy` against prod DB (after confirming target DB).
3. **Backend**: run `npm run build` then `npm start` (or `node dist/index.js`). Ensure `NODE_ENV=production`, proper CORS, correct `PUBLIC_SITE_URL`.
4. **Scheduler (optional but recommended)**: `npm run scheduler` in its own process (single instance). Or cron the one-shot `npx tsx scripts/reconcile-payments.ts 10 25` every 10 min.
5. **Frontend**: `npm run build` then `npm start` (or serve `standalone` output). Set `NEXT_PUBLIC_SITE_URL` to the public origin.

## 6. Verification Checklist
- Health: `GET /api/v1/health` (returns 503 if DB down)
- Payments status: `GET /api/v1/payments/status` (razorpay webhook configured flags)
- Forgot-password with SMTP: emails link containing `/reset-password?token=`; response never leaks token; errors logged masked.
- Webhook: invalid signature → 400; event dedup → ack; 5xx on processing → retries.
- Admin endpoints protected: unauth → 401; non-admin → 403.
- Orders disabled: `ordersDisabled.test.ts` confirms 503 when gate disabled (and in practice no mutations).

## 7. Operational Notes & Recommendations
- **Trust proxy**: `app.ts:30` hardcodes `app.set('trust proxy', 1)`. If behind more than one proxy, make it env-driven (`TRUST_PROXY`).
- **Rate limiting**: in-memory. For >1 backend replica, add a shared store (Redis) for `express-rate-limit` and stop relying on per-process memory.
- **Scheduler**: shutdown waits for in-flight cycle (up to 10s) then disconnects. Still single-instance recommended; DB guards protect against cross-process races.
- **PII in logs**: recipient emails are masked (`maskEmail`); IP logged only at `razorpay_webhook_invalid_signature` (security event) — acceptable for ops.
- **Backup retention**: `pruneOldDumps` deletes files in `BACKUP_DIR` by age without interactive confirmation (scheduled cleanup). Ensure `BACKUP_DIR` is scoped to this service.
- **`.env` on disk**: contains plaintext secrets (gitignored); treat the host filesystem as sensitive and rotate credentials if copied/shared.
- **Razorpay webhook**: forward raw body to `/api/v1/payments/razorpay/webhook`; webhook not rate-limited (mitigated by HMAC, no public benefit from global limiter here).
- **No deployment manifests**: repo has no Dockerfile/compose/Procfile/vercel.json/etc. Infrastructure choice is left to you.

## 8. Quick Test Commands
- Backend: `npm run typecheck`, `npm run build`, `npx vitest run` (265/269 tests as of this run)
- Frontend: `npm run typecheck`, `npm run lint`, `npx vitest run` (104 tests), `npm run build`

## 9. Support Contacts (config)
- Admin: `draftox0@gmail.com`
- Support: `draftoxcustomersupport@gmail.com`
- Socials: Instagram `https://www.instagram.com/draftox.coders/`, YouTube `https://www.youtube.com/@Draftoxcoders`, X `https://x.com/Draftoxcoders`
