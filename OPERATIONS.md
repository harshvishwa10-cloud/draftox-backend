# DRAFTOX Operations Runbook

Operational procedures for the DRAFTOX backend: scheduled payment tasks,
database backup/restore, and alerting. Nothing here sends money or enables live
checkout — `STORE_ORDERS_ENABLED` stays off unless deliberately turned on.

---

## 1. Payment operations worker (reconciliation + monitoring)

`scripts/scheduler.ts` is a long-running worker that periodically:

1. checks database connectivity,
2. runs the payment reconciliation sweep (the safety net for missed/failed
   Razorpay webhooks), and
3. checks the refund SLA (refunds not completed within 24h raise an alert).

### Run it

```bash
npm run scheduler
```

Configuration (all optional):

| Variable | Default | Meaning |
| --- | --- | --- |
| `SCHEDULER_INTERVAL_MINUTES` | `10` | How often a cycle runs |
| `RECONCILE_GRACE_MINUTES` | `10` | Age before a pending order is swept |
| `RECONCILE_BATCH_SIZE` | `25` | Max orders swept per cycle |

### Hosting (no cron assumption)

The worker is a plain Node process, so it fits any always-on host:

- **systemd**: unit with `ExecStart=/usr/bin/npm run scheduler`, `Restart=always`.
- **pm2**: `pm2 start "npm run scheduler" --name draftox-ops`.
- **Docker / k8s**: a second container / a `CronJob` invoking the one-shot script.

If your platform prefers its own scheduler over a long-running process, run the
one-shot entrypoint instead:

```bash
npx tsx scripts/reconcile-payments.ts 10 25   # grace minutes, batch size
```

### Safety properties

- **Overlap-safe in-process**: a cycle still running makes the next tick a no-op.
- **Idempotent across processes**: the reconciliation uses guarded DB updates, so
  two workers racing can never double-mark an order PAID. Coordination is the
  database state, not a lock.
- **Bounded**: each sweep reads at most `RECONCILE_BATCH_SIZE` orders and applies
  a 10s per-provider timeout.
- **No money movement**: reconciliation never refunds and never marks a
  cancelled order paid; such cases become `PaymentException` rows for humans.

---

## 2. Backups

### Strategy

- **Primary**: use your managed PostgreSQL provider's automated backups / PITR
  (Neon, Supabase, RDS, Cloud SQL). These are the authoritative recovery source
  and should be enabled and monitored on the provider side.
- **Secondary/portable**: `scripts/backup-db.ts` produces a compressed
  custom-format dump, verifies it, and optionally encrypts it:

```bash
npm run backup
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | — | Source connection (password never logged) |
| `BACKUP_DIR` | `<repo>/backups` | Output directory (gitignored) |
| `BACKUP_RETENTION_DAYS` | `7` | Delete local dumps older than this (`0` disables) |
| `BACKUP_GPG_RECIPIENT` | — | Encrypt with `gpg --encrypt` and remove plaintext |

Requirements: `pg_dump` / `pg_restore` (and `gpg` if encrypting) on `PATH`.

The run **fails loudly and raises a `backup_failed` alert** if the dump cannot be
created or fails verification. On success it clears that alert.

### Off-site & encryption

The script does not upload. Store backups **encrypted, off-site, with restrictive
permissions and versioning** — e.g. an object-storage bucket with server-side
encryption and object-lock, or `BACKUP_GPG_RECIPIENT` plus a sync step. Never
commit dumps or place them in a web-served directory (`.gitignore` already
excludes `backups/`, `*.dump`, `*.sql`).

### Suggested schedule

- Provider PITR: continuous (verify the retention window on the provider).
- Portable dump: daily, off-peak, followed by an immediate off-site copy.

### RPO / RTO (targets, not measurements)

- **RPO target**: ≤ 5 minutes (provider PITR); ≤ 24 hours (portable daily dump).
- **RTO target**: ≤ 1 hour.

These are targets. Until a restore is actually performed and timed on an
isolated database (see below), they are **not verified**.

---

## 3. Restore (isolated test)

Restores must target an **isolated** database, never production.

```bash
RESTORE_CONFIRM=restore \
RESTORE_DATABASE_URL=postgres://user:pass@host:5432/draftox_restore \
npx tsx scripts/restore-db.ts backups/draftox_<timestamp>.dump --drop
```

Guards:
- `RESTORE_CONFIRM` must equal exactly `restore`.
- `RESTORE_DATABASE_URL` is required and must differ from `DATABASE_URL`.
- The target database name must look isolated (`restore`/`isolated`/`test`/
  `dev`/`staging`/`local`/`preview`) unless `RESTORE_ALLOW_UNSAFE=true`.

### Verified restore checklist

1. Provision a throwaway database.
2. Restore the latest artifact with `--drop`.
3. Run `npx prisma migrate status` against the target — it must report "no
   pending migrations".
4. Spot-check row counts (`Order`, `Refund`, `PaymentException`, `WebhookEvent`).
5. Record the elapsed restore time; update the achieved RTO here.

---

## 4. Alerting

`src/lib/alerts.ts` is a small, fail-safe alerting façade. Alerts are:

- **deduplicated** per stable key with a 30-minute cooldown,
- **recoverable** (`clearAlert` announces the all-clear once), and
- **secret-free** (only ids/counts/short messages are rendered).

The default sink emails `OWNER_NOTIFICATION_EMAIL` (falling back to
`ADMIN_EMAIL`) through the existing mailer. Register a different sink
(chat/pager/webhook) at startup via `registerAlertSink`.

Signals raised automatically:

| Key | Source | Meaning |
| --- | --- | --- |
| `payment_exception:<KIND>` | webhook / reconciliation | A payment needs a human look |
| `webhook_failed` | webhook processing threw | Provider will retry; a `WEBHOOK_FAILED` exception is queued |
| `reconcile_job_failed` | worker / one-shot script | A sweep reported failures |
| `refund_sla_breach` | worker | Refunds pending > 24h |
| `backup_failed` | backup script | Backup failed or failed verification |
| `database_unreachable` | worker | DB connectivity check failed |
| `payment_scheduler_failed` | worker | A monitoring cycle threw |

Email is only delivered when `EMAIL_PROVIDER=smtp` is configured; otherwise
alerts are logged and delivery reports as failed (honest, never a false
"delivered").

---

## 5. Refund SLA (24-hour goal)

The goal: **initiate** a refund within 24 hours of the obligation arising
(order cancelled by customer, or a return resolved to refund). The worker
raises `refund_sla_breach` when any refund is still not `SUCCESS` past 24h.

Refund states are distinct and truthful:

| State | Meaning |
| --- | --- |
| `REQUESTED` | Obligation recorded; not yet submitted |
| `PROCESSING` | Submitted to the provider; awaiting confirmation |
| `SUCCESS` | Provider **confirmed** the money moved |
| `FAILED` | Provider rejected it; retryable |
| `MANUAL_REVIEW` | No verified payment id or provider unconfigured; a human must finish it |

Never treat a refund as done without a provider-confirmed `SUCCESS`. Use the
admin Payments page to inspect and safely retry (`POST /admin/refunds/:id/retry`,
guarded so it cannot double-post).
