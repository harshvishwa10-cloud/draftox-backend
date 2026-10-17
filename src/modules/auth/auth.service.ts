import bcrypt from 'bcryptjs';
import type { User } from '@prisma/client';
import { env, isProduction, publicSiteUrl, supportEmail } from '../../config/env.js';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { sendMail } from '../../lib/mailer.js';
import { ApiError } from '../../utils/ApiError.js';
import { generateToken, hashToken } from '../../utils/cookies.js';
import { normalizeEmail } from '../../utils/normalize.js';
import { effectiveRoleForUser, isAuthorizedAdminEmail } from './authorization.js';
import type { ForgotPasswordInput, LoginInput, RegisterInput, ResetPasswordInput } from '../../schemas/auth.schema.js';

const BCRYPT_ROUNDS = 12;
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

export interface PublicUser {
  id: string;
  name: string;
  email: string;
  role: 'CUSTOMER' | 'ADMIN';
  createdAt: Date;
}

/**
 * Serializes a user for the client. The exposed `role` is the EFFECTIVE role
 * (authorized admin email + verified email), never the raw database role, so a
 * stray `role = 'ADMIN'` on another account can never surface.
 */
export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: effectiveRoleForUser(user),
    createdAt: user.createdAt,
  };
}

export interface IssuedSession {
  token: string;
  expiresAt: Date;
}

async function createSession(userId: string, meta: { userAgent?: string; ip?: string }): Promise<IssuedSession> {
  const token = generateToken(48);
  const expiresAt = new Date(Date.now() + env.SESSION_TTL_HOURS * 60 * 60 * 1000);
  await prisma.session.create({
    data: {
      tokenHash: hashToken(token),
      userId,
      expiresAt,
      userAgent: meta.userAgent?.slice(0, 300),
      ip: meta.ip,
    },
  });
  return { token, expiresAt };
}

export async function register(
  input: RegisterInput,
  meta: { userAgent?: string; ip?: string },
): Promise<{ user: PublicUser; session: IssuedSession }> {
  const email = normalizeEmail(input.email);

  // An authorized administrator is never a password account. Blocking password
  // registration for a reserved admin email closes the account-pre-registration
  // window that could otherwise let a third party create the admin row first and
  // later have their password attached to the Google-linked admin identity.
  // Admins sign in with Google/Firebase only.
  if (isAuthorizedAdminEmail(email)) {
    throw ApiError.conflict(
      'This email address cannot be registered with a password. Please sign in with Google instead.',
    );
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    throw ApiError.conflict('An account with this email already exists');
  }

  const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
  const user = await prisma.user.create({
    data: {
      name: input.name.trim(),
      email,
      passwordHash,
      role: 'CUSTOMER',
    },
  });

  const session = await createSession(user.id, meta);
  return { user: toPublicUser(user), session };
}

export async function login(
  input: LoginInput,
  meta: { userAgent?: string; ip?: string },
): Promise<{ user: PublicUser; session: IssuedSession }> {
  const email = normalizeEmail(input.email);
  const user = await prisma.user.findUnique({ where: { email } });

  // Generic error: never reveal whether the account exists.
  if (!user || !user.passwordHash) {
    throw ApiError.unauthorized('Invalid email or password');
  }

  const valid = await bcrypt.compare(input.password, user.passwordHash);
  if (!valid) {
    throw ApiError.unauthorized('Invalid email or password');
  }

  const session = await createSession(user.id, meta);
  return { user: toPublicUser(user), session };
}

export async function logout(token: string | undefined): Promise<void> {
  if (!token) return;
  await prisma.session
    .deleteMany({ where: { tokenHash: hashToken(token) } })
    .catch(() => undefined);
}

export async function getUserById(id: string): Promise<PublicUser> {
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) {
    throw ApiError.unauthorized();
  }
  return toPublicUser(user);
}

export async function getUserBySessionToken(token: string): Promise<PublicUser> {
  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true },
  });
  if (!session || session.expiresAt.getTime() <= Date.now()) {
    throw ApiError.unauthorized('Session expired, please sign in again');
  }
  return toPublicUser(session.user);
}

export interface ForgotPasswordResult {
  message: string;
  devToken?: string;
}

export async function forgotPassword(input: ForgotPasswordInput): Promise<ForgotPasswordResult> {
  const email = normalizeEmail(input.email);
  const user = await prisma.user.findUnique({ where: { email } });

  const generic: ForgotPasswordResult = {
    message: 'If an account exists for that email, a password reset link has been issued.',
  };

  if (!user) {
    return generic;
  }

  // Invalidate previous outstanding tokens for a clean single-use flow.
  await prisma.passwordResetToken.updateMany({
    where: { userId: user.id, usedAt: null },
    data: { usedAt: new Date() },
  });

  const rawToken = generateToken(32);
  await prisma.passwordResetToken.create({
    data: {
      tokenHash: hashToken(rawToken),
      userId: user.id,
      expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
    },
  });

  if (env.EMAIL_PROVIDER === 'none') {
    if (isProduction) {
      logger.error('password_reset_email_unavailable', { userId: user.id });
      throw ApiError.serviceUnavailable(
        'Password reset is unavailable because email delivery is not configured on this server',
      );
    }
    // Honest development-mode response: no email was sent; the token is returned here.
    logger.warn('password_reset_dev_mode_no_email', { userId: user.id });
    return {
      message:
        'Development mode: email delivery is not configured, so no email was sent. The reset token is returned below for local testing only.',
      devToken: rawToken,
    };
  }

  // SMTP delivery is configured: send the reset link. The reset token is only
  // ever placed in the email (never in the API response), and the response stays
  // generic so it cannot be used to enumerate registered accounts.
  const resetUrl = `${publicSiteUrl}/reset-password?token=${encodeURIComponent(rawToken)}`;
  const ttlMinutes = Math.round(RESET_TOKEN_TTL_MS / 60000);
  const result = await sendMail({
    to: email,
    subject: 'Reset your DRAFTOX password',
    text: [
      'Reset your DRAFTOX password',
      '',
      'We received a request to reset the password for your DRAFTOX account.',
      `Open this link to choose a new password (valid for ${ttlMinutes} minutes):`,
      resetUrl,
      '',
      'If you did not request this, you can safely ignore this email — your password will not change.',
      `Need help? Contact ${supportEmail}.`,
    ].join('\n'),
    html: [
      '<h2 style="margin:0 0 8px;font-size:16px;color:#0b1b33;">Reset your DRAFTOX password</h2>',
      '<p style="margin:0 0 12px;">We received a request to reset the password for your DRAFTOX account.</p>',
      `<p style="margin:0 0 16px;">This link is valid for ${ttlMinutes} minutes:</p>`,
      `<p style="margin:0 0 16px;"><a href="${resetUrl}" style="display:inline-block;background:#0b1b33;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:600;">Choose a new password</a></p>`,
      '<p style="margin:0 0 12px;color:#6b7280;font-size:13px;">If the button does not work, copy and paste this link into your browser:<br/>',
      `<span style="word-break:break-all;">${resetUrl}</span></p>`,
      '<p style="margin:16px 0 0;color:#6b7280;font-size:13px;">If you did not request this, you can safely ignore this email — your password will not change.</p>',
      `<p style="margin:8px 0 0;color:#6b7280;font-size:13px;">Need help? Contact ${supportEmail}.</p>`,
    ].join('\n'),
  });

  if (result.accepted) {
    logger.info('password_reset_email_sent', { userId: user.id });
  } else {
    // Do not surface delivery failure to the caller (avoids email enumeration).
    logger.error('password_reset_email_failed', {
      userId: user.id,
      error: result.error ?? 'unknown',
    });
  }

  return generic;
}

export async function resetPassword(input: ResetPasswordInput): Promise<void> {
  const tokenRow = await prisma.passwordResetToken.findUnique({
    where: { tokenHash: hashToken(input.token) },
  });

  if (!tokenRow || tokenRow.usedAt !== null || tokenRow.expiresAt.getTime() <= Date.now()) {
    throw ApiError.badRequest('Invalid or expired reset token');
  }

  const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);

  await prisma.$transaction([
    prisma.user.update({
      where: { id: tokenRow.userId },
      data: { passwordHash },
    }),
    prisma.passwordResetToken.update({
      where: { id: tokenRow.id },
      data: { usedAt: new Date() },
    }),
    // Kill every active session after a password reset.
    prisma.session.deleteMany({ where: { userId: tokenRow.userId } }),
  ]);
}

export async function upsertGoogleUser(identity: {
  googleId: string;
  email: string;
  name: string;
  emailVerified: boolean;
}, meta: { userAgent?: string; ip?: string }): Promise<{ user: PublicUser; session: IssuedSession }> {
  const email = normalizeEmail(identity.email);
  // Only ever propagate a verified flag that the trusted Google identity
  // reported; an unverified/missing email can never become an admin.
  const emailVerified = identity.emailVerified === true;

  const byGoogle = await prisma.user.findUnique({ where: { googleId: identity.googleId } });
  if (byGoogle) {
    const updated = await prisma.user.update({
      where: { id: byGoogle.id },
      data: { emailVerified: byGoogle.emailVerified || emailVerified },
    });
    const session = await createSession(updated.id, meta);
    return { user: toPublicUser(updated), session };
  }

  const byEmail = await prisma.user.findUnique({ where: { email } });
  if (byEmail) {
    // Link the Google identity to the existing account. The email came from
    // Google's verified ID token, not from the client, so this is safe.
    // For an authorized administrator, Google is the ONLY credential: never
    // leave a password attached, so a legacy password row (created before
    // password registration of the admin email was blocked) cannot be used to
    // sign in.
    const isAdminEmail = isAuthorizedAdminEmail(email);
    const updated = await prisma.user.update({
      where: { id: byEmail.id },
      data: {
        googleId: identity.googleId,
        emailVerified: byEmail.emailVerified || emailVerified,
        ...(isAdminEmail ? { passwordHash: null } : {}),
      },
    });
    const session = await createSession(updated.id, meta);
    return { user: toPublicUser(updated), session };
  }

  const created = await prisma.user.create({
    data: {
      name: identity.name.slice(0, 100) || email.split('@')[0],
      email,
      googleId: identity.googleId,
      passwordHash: null, // Google-only account
      emailVerified,
      role: 'CUSTOMER',
    },
  });
  const session = await createSession(created.id, meta);
  return { user: toPublicUser(created), session };
}
