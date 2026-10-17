/**
 * Logical database backup for DRAFTOX (PostgreSQL).
 *
 * Produces a compressed custom-format dump with `pg_dump`, VERIFIES it is
 * readable with `pg_restore --list`, and (optionally) encrypts it with GPG
 * before the plaintext dump is removed. It then raises or clears a deduplicated
 * `backup_failed` operational alert.
 *
 * It deliberately does NOT upload anywhere: choose your own encrypted off-site
 * destination (object storage with SSE + versioning, a provider snapshot
 * bucket, etc.) and point it at BACKUP_DIR, or copy the artifact after the run.
 * See OPERATIONS.md for the full backup/restore plan, RPO/RTO and a tested
 * restore procedure on an isolated database.
 *
 * Requirements:
 *   - `pg_dump` and `pg_restore` on PATH (PostgreSQL client tools). For a
 *     managed database (Neon/Supabase/RDS), prefer the provider's PITR backups
 *     and treat this script as a portable secondary copy.
 *
 * Usage:
 *   npm run backup
 *
 * Environment (all optional except DATABASE_URL):
 *   DATABASE_URL                connection string to dump (password is never logged)
 *   BACKUP_DIR                  output directory (default: <repo>/backups)
 *   BACKUP_RETENTION_DAYS       delete local dumps older than this (default: 7; 0 disables)
 *   BACKUP_GPG_RECIPIENT        when set, encrypt with `gpg --encrypt` and remove plaintext
 */
import 'dotenv/config';
import { spawn } from 'node:child_process';
import { mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { logger } from '../src/lib/logger.js';
import { clearAlert, sendAlert } from '../src/lib/alerts.js';

interface Connection {
  host: string;
  port: string;
  user: string;
  password: string;
  database: string;
}

/** Parses a postgres:// URL into discrete libpq fields (never logs secrets). */
function parseConnection(raw: string): Connection {
  const url = new URL(raw);
  return {
    host: url.hostname,
    port: url.port || '5432',
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, ''),
  };
}

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs a command, capturing output. Rejects only on spawn failure (e.g. ENOENT). */
function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<CommandResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', rejectPromise);
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }));
  });
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function pruneOldDumps(dir: string, retentionDays: number): Promise<number> {
  if (retentionDays <= 0) return 0;
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return 0;
  }
  for (const name of entries) {
    if (!/\.dump(\.gpg)?$/.test(name)) continue;
    const full = join(dir, name);
    try {
      const info = await stat(full);
      if (info.mtimeMs < cutoff) {
        await unlink(full);
        removed += 1;
      }
    } catch {
      // Ignore a file that disappeared underneath us.
    }
  }
  return removed;
}

async function fail(message: string, metadata?: Record<string, unknown>): Promise<never> {
  logger.error('backup_failed', { error: message, ...(metadata ?? {}) });
  await sendAlert({
    key: 'backup_failed',
    severity: 'critical',
    title: 'Database backup failed',
    message,
    metadata,
  });
  process.exit(1);
}

async function main(): Promise<void> {
  const raw = (process.env.DATABASE_URL ?? '').trim();
  if (!raw) {
    await fail('DATABASE_URL is not set — cannot back up.');
    return;
  }

  let conn: Connection;
  try {
    conn = parseConnection(raw);
  } catch {
    await fail('DATABASE_URL is not a valid PostgreSQL connection string.');
    return;
  }
  if (!conn.database) {
    await fail('DATABASE_URL does not name a database.');
    return;
  }

  const dir = resolve(process.env.BACKUP_DIR ?? join(process.cwd(), 'backups'));
  const retentionDays = positiveInt(process.env.BACKUP_RETENTION_DAYS, 7);
  const gpgRecipient = (process.env.BACKUP_GPG_RECIPIENT ?? '').trim();
  await mkdir(dir, { recursive: true });

  const plainPath = join(dir, `draftox_${timestamp()}.dump`);
  const dumpEnv: NodeJS.ProcessEnv = { ...process.env, PGPASSWORD: conn.password };

  logger.info('backup_started', { host: conn.host, database: conn.database, dir });

  // 1. Dump in custom format (compressed, restorable selectively).
  let dump: CommandResult;
  try {
    dump = await run(
      'pg_dump',
      [
        '--format=custom',
        '--no-owner',
        '--no-privileges',
        '-h',
        conn.host,
        '-p',
        conn.port,
        '-U',
        conn.user,
        '-d',
        conn.database,
        '-f',
        plainPath,
      ],
      dumpEnv,
    );
  } catch (err) {
    await fail(
      '`pg_dump` could not be run. Install the PostgreSQL client tools and ensure pg_dump is on PATH.',
      { error: err instanceof Error ? err.message : String(err) },
    );
    return;
  }
  if (dump.code !== 0) {
    await fail('pg_dump exited with an error.', { stderr: dump.stderr.slice(0, 300) });
    return;
  }

  // 2. Verify the artifact is a readable archive (guards against 0-byte files).
  let verify: CommandResult;
  try {
    verify = await run('pg_restore', ['--list', plainPath], process.env);
  } catch {
    await fail('`pg_restore` could not be run to verify the dump.');
    return;
  }
  const tocEntries = verify.stdout
    .split('\n')
    .filter((line) => /;\s*Type:/.test(line) || /\sTABLE\s/.test(line)).length;
  if (verify.code !== 0 || tocEntries === 0) {
    await unlink(plainPath).catch(() => undefined);
    await fail('Backup verification failed: the dump is not a readable archive.', {
      stderr: verify.stderr.slice(0, 300),
    });
    return;
  }

  // 3. Optionally encrypt, then remove the plaintext artifact.
  let finalPath = plainPath;
  if (gpgRecipient) {
    const encrypted = `${plainPath}.gpg`;
    let enc: CommandResult;
    try {
      enc = await run(
        'gpg',
        ['--batch', '--yes', '--encrypt', '--recipient', gpgRecipient, '--output', encrypted, plainPath],
        process.env,
      );
    } catch {
      await fail('`gpg` is required for encryption but could not be run.');
      return;
    }
    if (enc.code !== 0) {
      await unlink(encrypted).catch(() => undefined);
      await fail('GPG encryption of the backup failed.', { stderr: enc.stderr.slice(0, 300) });
      return;
    }
    await unlink(plainPath).catch(() => undefined);
    finalPath = encrypted;
  }

  const info = await stat(finalPath);
  const pruned = await pruneOldDumps(dir, retentionDays);

  logger.info('backup_complete', {
    file: finalPath,
    bytes: info.size,
    tocEntries,
    encrypted: Boolean(gpgRecipient),
    pruned,
  });

  await clearAlert('backup_failed', {
    title: 'Database backup recovered',
    message: 'The latest database backup completed and verified successfully.',
  });
  process.exit(0);
}

main().catch(async (err) => {
  // Any unexpected throw still surfaces as a backup failure alert.
  await fail('Unexpected error during backup.', {
    error: err instanceof Error ? err.message : String(err),
  });
});
