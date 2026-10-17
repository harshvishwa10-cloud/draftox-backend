/**
 * Guarded database restore for DRAFTOX (PostgreSQL).
 *
 * Restores a dump produced by scripts/backup-db.ts into an ISOLATED database.
 * This is intentionally hard to run by accident: it refuses unless you both
 * (a) set RESTORE_CONFIRM=restore and (b) point RESTORE_DATABASE_URL at a
 * database whose name looks isolated (restore/isolated/test/dev/staging/local).
 * It also refuses to restore into the same database the app itself uses.
 *
 * NEVER run this against production. Practise the procedure on an isolated
 * database and record the verified RPO/RTO in OPERATIONS.md.
 *
 * Usage:
 *   RESTORE_CONFIRM=restore RESTORE_DATABASE_URL=postgres://user:pass@host:5432/draftox_restore \
 *     npx tsx scripts/restore-db.ts backups/draftox_<timestamp>.dump [--drop]
 *
 * `--drop` passes `--clean --if-exists` to pg_restore (drops objects first).
 * Without it, the restore expects an empty target database.
 *
 * Environment:
 *   RESTORE_DATABASE_URL   REQUIRED. Target connection (must differ from DATABASE_URL).
 *   RESTORE_CONFIRM        REQUIRED. Must equal "restore".
 *   RESTORE_ALLOW_UNSAFE   Set to "true" to bypass the isolated-name check (dangerous).
 */
import 'dotenv/config';
import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { logger } from '../src/lib/logger.js';

function parseTarget(raw: string): { host: string; port: string; user: string; password: string; database: string } {
  const url = new URL(raw);
  return {
    host: url.hostname,
    port: url.port || '5432',
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, ''),
  };
}

const ISOLATED_HINTS = /(restore|isolated|sandbox|test|dev|staging|local|preview)/i;

function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<number | null> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { env, stdio: 'inherit', windowsHide: true });
    child.on('error', rejectPromise);
    child.on('close', (code) => resolvePromise(code));
  });
}

async function main(): Promise<void> {
  if ((process.env.RESTORE_CONFIRM ?? '') !== 'restore') {
    logger.error('restore_refused', { reason: 'RESTORE_CONFIRM is not "restore"' });
    process.stdout.write('Refusing to restore: set RESTORE_CONFIRM=restore to proceed.\n');
    process.exit(1);
  }

  const targetRaw = (process.env.RESTORE_DATABASE_URL ?? '').trim();
  if (!targetRaw) {
    logger.error('restore_refused', { reason: 'RESTORE_DATABASE_URL missing' });
    process.stdout.write('Refusing to restore: RESTORE_DATABASE_URL is required.\n');
    process.exit(1);
  }

  const appRaw = (process.env.DATABASE_URL ?? '').trim();
  if (appRaw && appRaw === targetRaw) {
    logger.error('restore_refused', { reason: 'target equals the application database' });
    process.stdout.write('Refusing to restore into the application database (DATABASE_URL).\n');
    process.exit(1);
  }

  const target = parseTarget(targetRaw);
  const allowUnsafe = (process.env.RESTORE_ALLOW_UNSAFE ?? '') === 'true';
  if (!allowUnsafe && !ISOLATED_HINTS.test(target.database)) {
    logger.error('restore_refused', { reason: 'target database name does not look isolated', database: target.database });
    process.stdout.write(
      `Refusing to restore into "${target.database}": the name does not look isolated.\n` +
        'Use a database named e.g. draftox_restore, or set RESTORE_ALLOW_UNSAFE=true (dangerous).\n',
    );
    process.exit(1);
  }

  const fileArg = process.argv[2];
  if (!fileArg) {
    process.stdout.write('Usage: npx tsx scripts/restore-db.ts <dump-file> [--drop]\n');
    process.exit(1);
  }
  const dumpPath = resolve(fileArg);
  try {
    await stat(dumpPath);
  } catch {
    process.stdout.write(`Dump file not found: ${dumpPath}\n`);
    process.exit(1);
  }

  const drop = process.argv.includes('--drop');
  const args = [
    '--no-owner',
    '--no-privileges',
    ...(drop ? ['--clean', '--if-exists'] : []),
    '-h',
    target.host,
    '-p',
    target.port,
    '-U',
    target.user,
    '-d',
    target.database,
    dumpPath,
  ];

  logger.info('restore_started', { host: target.host, database: target.database, drop, file: dumpPath });
  const env: NodeJS.ProcessEnv = { ...process.env, PGPASSWORD: target.password };

  let code: number | null;
  try {
    code = await run('pg_restore', args, env);
  } catch {
    logger.error('restore_failed', { reason: 'pg_restore could not be run (is it on PATH?)' });
    process.exit(1);
  }

  if (code !== 0) {
    logger.error('restore_failed', { exitCode: code });
    process.exit(code ?? 1);
  }
  logger.info('restore_complete', { database: target.database });
  process.exit(0);
}

main().catch((err) => {
  logger.error('restore_fatal', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
