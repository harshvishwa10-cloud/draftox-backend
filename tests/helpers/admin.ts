import bcrypt from 'bcryptjs';
import type { Express } from 'express';
import { createAgent, type AgentWithCsrf } from './agent.js';

/** Primary authorized administrator email (matches the server default). */
export const ADMIN_EMAIL = 'draftox0@gmail.com';
export const ADMIN_PASSWORD = 'testadminpassword1';
export const ADMIN_NAME = 'Test Admin';
/**
 * The customer-support address: a RESTRICTED support account (configured in
 * SUPPORT_EMAILS), NOT an administrator. Also the shipment-email SENDER.
 */
export const SUPPORT_EMAIL = 'draftoxcustomersupport@gmail.com';
export const SUPPORT_PASSWORD = 'testsupportpassword1';
export const SUPPORT_NAME = 'DRAFTOX Support';

export interface Authed extends AgentWithCsrf {
  email: string;
  userId: string;
}

/**
 * Ensures a provider-VERIFIED account exists with a known password. Used for
 * BOTH the full-admin and the restricted-support test identities. The database
 * `role` is intentionally left as CUSTOMER to prove that authorization comes
 * from the server-side email allow-list + verification, not the role column.
 */
export async function ensureAdminUser(
  email: string = ADMIN_EMAIL,
  name: string = ADMIN_NAME,
  password: string = ADMIN_PASSWORD,
): Promise<string> {
  const { prisma } = await import('../../src/lib/prisma.js');
  const passwordHash = await bcrypt.hash(password, 8);
  const user = await prisma.user.upsert({
    where: { email },
    update: { emailVerified: true, passwordHash, role: 'CUSTOMER' },
    create: {
      name,
      email,
      emailVerified: true,
      passwordHash,
      role: 'CUSTOMER',
    },
    select: { id: true },
  });
  return user.id;
}

/** Signs an existing account in with email + password. */
export async function loginAgent(
  app: Express,
  email: string,
  password: string,
): Promise<Authed> {
  const { agent, csrfToken } = await createAgent(app);
  const res = await agent
    .post('/api/v1/auth/login')
    .set('X-CSRF-Token', csrfToken)
    .send({ email, password });
  if (res.status !== 200) {
    throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return { agent, csrfToken, email, userId: res.body.data.user.id as string };
}

let cached: Promise<Authed> | null = null;

/** Shared authorized-admin agent (primary account) for a test file. */
export function getAdminAgent(app: Express): Promise<Authed> {
  if (!cached) {
    cached = (async () => {
      await ensureAdminUser();
      return loginAgent(app, ADMIN_EMAIL, ADMIN_PASSWORD);
    })();
  }
  return cached;
}

let cachedSupport: Promise<Authed> | null = null;

/**
 * Shared RESTRICTED support agent — a verified support account that is NOT an
 * administrator. It may reach ONLY the public-request inbox routes, never the
 * order/payment/refund/returns admin routes.
 */
export function getSupportAgent(app: Express): Promise<Authed> {
  if (!cachedSupport) {
    cachedSupport = (async () => {
      await ensureAdminUser(SUPPORT_EMAIL, SUPPORT_NAME, SUPPORT_PASSWORD);
      return loginAgent(app, SUPPORT_EMAIL, SUPPORT_PASSWORD);
    })();
  }
  return cachedSupport;
}
