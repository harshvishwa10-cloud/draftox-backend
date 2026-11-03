import bcrypt from 'bcryptjs';
import type { Express } from 'express';
import { generateToken, hashToken } from '../../src/utils/cookies.js';
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

/**
 * Mints a legacy session row directly and attaches its cookie to a fresh agent.
 *
 * Administrator and support addresses are "reserved privileged" identities that
 * may only authenticate through Google/Firebase in production — password login
 * is deliberately rejected for them. These helpers therefore reproduce what a
 * successful provider sign-in leaves behind: a server-side session for an
 * email-verified account. Authorization is still exercised for real by the
 * middleware (email allow-list + verification), so tests never bypass it.
 */
async function createSessionForUser(userId: string): Promise<string> {
  const { prisma } = await import('../../src/lib/prisma.js');
  const token = generateToken(48);
  await prisma.session.create({
    data: {
      tokenHash: hashToken(token),
      userId,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
  });
  return token;
}

function attachSessionCookie(agent: AgentWithCsrf['agent'], token: string): void {
  // Supertest exposes superagent's cookie jar at runtime but not in its types.
  const jar = (agent as unknown as {
    jar: { setCookie: (cookie: string, domain: string, path: string) => unknown };
  }).jar;
  jar.setCookie(`draftox_session=${encodeURIComponent(token)}; Path=/`, '127.0.0.1', '/');
}

/** Fresh provider-verified session for a privileged identity (not cached). */
export async function createSessionAgent(
  app: Express,
  email: string = ADMIN_EMAIL,
  name: string = ADMIN_NAME,
  password: string = ADMIN_PASSWORD,
): Promise<Authed> {
  const userId = await ensureAdminUser(email, name, password);
  const { agent, csrfToken } = await createAgent(app);
  attachSessionCookie(agent, await createSessionForUser(userId));
  return { agent, csrfToken, email, userId };
}

/**
 * Session for an EXISTING user row, without touching its verification state.
 * Used to simulate a stale provider session for an unverified privileged email.
 */
export async function sessionAgentForEmail(app: Express, email: string): Promise<Authed> {
  const { prisma } = await import('../../src/lib/prisma.js');
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (!user) throw new Error(`No user row for ${email}`);
  const { agent, csrfToken } = await createAgent(app);
  attachSessionCookie(agent, await createSessionForUser(user.id));
  return { agent, csrfToken, email, userId: user.id };
}

/** Shared authorized-admin agent (primary account) for a test file. */
export function getAdminAgent(app: Express): Promise<Authed> {
  if (!cached) {
    cached = createSessionAgent(app);
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
    cachedSupport = createSessionAgent(app, SUPPORT_EMAIL, SUPPORT_NAME, SUPPORT_PASSWORD);
  }
  return cachedSupport;
}
