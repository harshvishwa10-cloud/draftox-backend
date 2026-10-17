// Runs once before the test suite. Applies test env vars to the main process.
import { execSync } from 'node:child_process';
import { resolveTestDatabaseUrl } from './helpers/testEnv.js';

const testDatabaseUrl = resolveTestDatabaseUrl();

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = testDatabaseUrl;

export default function globalSetup(): void {
  // Apply migrations to the dedicated test database, then seed it.
  execSync('npx prisma migrate deploy', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: testDatabaseUrl },
  });
  execSync('npx tsx prisma/seed.ts', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: testDatabaseUrl },
  });
}
