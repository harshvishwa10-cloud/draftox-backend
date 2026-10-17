/**
 * Central authorization policy for the DRAFTOX administrators.
 *
 * Administrator access is granted to a small, EXPLICIT set of accounts
 * identified by server-side configuration (`ADMIN_EMAIL` plus the
 * comma-separated `ADMIN_EMAILS`) AND a Google/Firebase-verified email. It is
 * deliberately NOT derived from the database `role` column, a frontend value, a
 * URL parameter, localStorage, or any user-editable field — so no other account
 * can ever be promoted, and an existing `role = 'ADMIN'` on a different email is
 * inert.
 *
 * The match is EXACT (case-insensitive) against each configured address; there
 * is no domain or prefix wildcard, so authorizing one address never authorizes
 * sibling accounts on the same domain.
 *
 * This is the single source of truth: middleware, the public user serializer,
 * and the OAuth/Firebase flows all use it instead of repeating ad-hoc checks.
 */
import type { User } from '@prisma/client';
import { env } from '../../config/env.js';
import { prisma } from '../../lib/prisma.js';
import { normalizeEmail, parseEmailList } from '../../utils/normalize.js';

export type EffectiveRole = 'CUSTOMER' | 'ADMIN';

/**
 * Every authorized administrator email, normalized. The UNION of the primary
 * `ADMIN_EMAIL` and all `ADMIN_EMAILS` entries (deduplicated). Never empty
 * because `ADMIN_EMAIL` has a built-in default.
 */
export const AUTHORIZED_ADMIN_EMAILS: readonly string[] = (() => {
  const set = new Set<string>();
  const primary = env.ADMIN_EMAIL?.trim();
  if (primary) set.add(normalizeEmail(primary));
  for (const entry of parseEmailList(env.ADMIN_EMAILS)) set.add(normalizeEmail(entry));
  return [...set];
})();

/**
 * The primary configured administrator email (backward-compatible single-value
 * export). Prefer {@link AUTHORIZED_ADMIN_EMAILS} for membership checks.
 */
export const AUTHORIZED_ADMIN_EMAIL = normalizeEmail(env.ADMIN_EMAIL);

/** True only for a configured admin email (exact, case/whitespace-insensitive). */
export function isAuthorizedAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return AUTHORIZED_ADMIN_EMAILS.includes(normalizeEmail(email));
}

export interface AdminCandidate {
  email: string;
  /** Set only when a trusted Google identity reported `email_verified: true`. */
  emailVerified: boolean;
}

/**
 * The effective role, independent of the database role. Admin requires BOTH an
 * authorized email and a verified email; anything else is a customer.
 */
export function effectiveRole(candidate: AdminCandidate): EffectiveRole {
  return isAuthorizedAdminEmail(candidate.email) && candidate.emailVerified === true
    ? 'ADMIN'
    : 'CUSTOMER';
}

/** True when the candidate is an authorized administrator. */
export function isAuthorizedAdmin(candidate: AdminCandidate): boolean {
  return effectiveRole(candidate) === 'ADMIN';
}

/**
 * Firebase custom-claim administrator check. The `admin` claim is set ONLY by
 * the server (Admin SDK `setCustomUserClaims`) — a client can never forge it. To
 * keep defence-in-depth, administrator access still ALSO requires an authorized
 * admin email, so a stale/incorrectly-set claim on another account is inert.
 */
export function isFirebaseAuthorizedAdmin(candidate: {
  email?: string | null;
  admin?: boolean;
}): boolean {
  return candidate.admin === true && isAuthorizedAdminEmail(candidate.email ?? null);
}

/** Effective role for a persisted user row. */
export function effectiveRoleForUser(user: Pick<User, 'email' | 'emailVerified'>): EffectiveRole {
  return effectiveRole({ email: user.email, emailVerified: user.emailVerified });
}

/**
 * Revokes administrator access from every account whose email is not one of the
 * authorized admins. Non-destructive: only the `role` column is touched, so
 * customer accounts, orders, addresses and history are preserved. The
 * email-based restriction is enforced in code regardless, so this is
 * defence-in-depth and mirrors the data migration.
 */
export async function revokeNonAuthorizedAdminRoles(): Promise<number> {
  const result = await prisma.user.updateMany({
    where: {
      role: 'ADMIN',
      NOT: { email: { in: [...AUTHORIZED_ADMIN_EMAILS] } },
    },
    data: { role: 'CUSTOMER' },
  });
  return result.count;
}
