import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function parseDotEnv(dir: string = rootDir): Record<string, string> {
  const file = path.join(dir, '.env');
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    let value = match[2];
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[match[1]] = value;
  }
  return out;
}

/** Derive the dedicated test database URL from DATABASE_URL (or TEST_DATABASE_URL). */
export function resolveTestDatabaseUrl(dotenv: Record<string, string> = parseDotEnv()): string {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;
  if (dotenv.TEST_DATABASE_URL) return dotenv.TEST_DATABASE_URL;
  const base = dotenv.DATABASE_URL ?? process.env.DATABASE_URL;
  if (!base) {
    throw new Error('DATABASE_URL must be set (in .env or the environment) to derive the test database');
  }
  const url = new URL(base);
  url.pathname = `${url.pathname.replace(/^\//, '')}_test`;
  return url.toString();
}

export { rootDir };
