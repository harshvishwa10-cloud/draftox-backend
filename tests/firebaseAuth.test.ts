// Exercises the Firebase Authentication integration end-to-end with the Admin
// SDK mocked out (no real Firebase project or network required). The DB is the
// real test database provided by globalSetup.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Express } from 'express';
import { createAgent, type AgentWithCsrf } from './helpers/agent.js';
import { ADMIN_EMAIL, SUPPORT_EMAIL } from './helpers/admin.js';

const { mockAuth } = vi.hoisted(() => ({
  mockAuth: {
    verifyIdToken: vi.fn(),
    createSessionCookie: vi.fn(),
    verifySessionCookie: vi.fn(),
    getUser: vi.fn(),
    setCustomUserClaims: vi.fn(),
    revokeRefreshTokens: vi.fn(),
  },
}));

// Replace the Admin SDK boundary so no credentials/network are needed. The
// service imports `getFirebaseAuth`, and the providers endpoint imports
// `firebaseAdminAvailable`; both come from the same module.
vi.mock('../src/lib/firebase/admin.js', () => ({
  firebaseAdminAvailable: true,
  getFirebaseAuth: () => mockAuth,
  __resetFirebaseAdminForTests: () => undefined,
}));

let app: Express;

beforeAll(async () => {
  const mod = await import('../src/app.js');
  app = mod.createApp();
});

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.getUser.mockResolvedValue({ customClaims: {} });
  mockAuth.setCustomUserClaims.mockResolvedValue(undefined);
  mockAuth.revokeRefreshTokens.mockResolvedValue(undefined);
});

function uniqueEmail(prefix = 'fb-user'): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

function exchange(agent: AgentWithCsrf['agent'], csrfToken: string, idToken: string) {
  return agent
    .post('/api/v1/auth/firebase/session')
    .set('X-CSRF-Token', csrfToken)
    // Real Firebase ID tokens are long JWTs; pad test values past the schema min.
    .send({ idToken: idToken.padEnd(24, '0') });
}

describe('Firebase session-cookie authentication', () => {
  it('exchanges a verified ID token for a session cookie and authenticates /auth/me', async () => {
    const email = uniqueEmail();
    mockAuth.verifyIdToken.mockResolvedValue({
      uid: 'uid-customer',
      email,
      email_verified: true,
      name: 'Firebase Customer',
    });
    mockAuth.createSessionCookie.mockResolvedValue('fb-cookie-customer');
    mockAuth.verifySessionCookie.mockResolvedValue({
      uid: 'uid-customer',
      email,
      email_verified: true,
    });

    const { agent, csrfToken } = await createAgent(app);
    const res = await exchange(agent, csrfToken, 'id-token-customer');

    expect(res.status).toBe(200);
    expect(res.body.data.user.role).toBe('CUSTOMER');
    expect(res.body.data.user.email).toBe(email);
    // A hardened, HttpOnly session cookie is set (never the raw token).
    const setCookie = res.headers['set-cookie'] as unknown as string[];
    const fbCookie = setCookie.find((c) => c.startsWith('draftox_fb_session='));
    expect(fbCookie).toBeTruthy();
    expect(fbCookie).toContain('HttpOnly');

    const me = await agent.get('/api/v1/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.data.user.email).toBe(email);

    // A plain customer cannot reach the admin API.
    expect((await agent.get('/api/v1/admin/orders')).status).toBe(403);
  });

  it('rejects an invalid/expired ID token with 401', async () => {
    mockAuth.verifyIdToken.mockRejectedValue(new Error('expired'));

    const { agent, csrfToken } = await createAgent(app);
    const res = await exchange(agent, csrfToken, 'bad-token');
    expect(res.status).toBe(401);
    expect((await agent.get('/api/v1/auth/me')).status).toBe(401);
  });

  it('rejects a token with no email (400) and never authenticates it', async () => {
    mockAuth.verifyIdToken.mockResolvedValue({ uid: 'anon' });

    const { agent, csrfToken } = await createAgent(app);
    const res = await exchange(agent, csrfToken, 'anonymous-token');
    expect(res.status).toBe(400);
  });

  it('grants admin to the verified authorized email and writes the admin claim', async () => {
    mockAuth.verifyIdToken.mockResolvedValue({
      uid: 'uid-admin',
      email: ADMIN_EMAIL,
      email_verified: true,
      name: 'DRAFTOX Owner',
    });
    mockAuth.createSessionCookie.mockResolvedValue('fb-cookie-admin');
    mockAuth.verifySessionCookie.mockResolvedValue({
      uid: 'uid-admin',
      email: ADMIN_EMAIL,
      email_verified: true,
      admin: true,
    });

    const { agent, csrfToken } = await createAgent(app);
    const res = await exchange(agent, csrfToken, 'id-token-admin');
    expect(res.status).toBe(200);

    // The server granted the admin custom claim (Admin SDK only).
    expect(mockAuth.setCustomUserClaims).toHaveBeenCalledWith('uid-admin', { admin: true });

    const me = await agent.get('/api/v1/auth/me');
    expect(me.body.data.user.role).toBe('ADMIN');
    expect((await agent.get('/api/v1/admin/orders')).status).toBe(200);
  });

  it('keeps the verified support account a RESTRICTED non-admin (no claim, inbox only)', async () => {
    mockAuth.verifyIdToken.mockResolvedValue({
      uid: 'uid-support-account',
      email: SUPPORT_EMAIL,
      email_verified: true,
      name: 'DRAFTOX Support',
    });
    mockAuth.createSessionCookie.mockResolvedValue('fb-cookie-support-account');
    mockAuth.verifySessionCookie.mockResolvedValue({
      uid: 'uid-support-account',
      email: SUPPORT_EMAIL,
      email_verified: true,
    });

    const { agent, csrfToken } = await createAgent(app);
    const res = await exchange(agent, csrfToken, 'id-token-support-account');
    expect(res.status).toBe(200);

    // The support account is NEVER granted the admin custom claim.
    expect(mockAuth.setCustomUserClaims).not.toHaveBeenCalled();

    const me = await agent.get('/api/v1/auth/me');
    expect(me.body.data.user.role).toBe('CUSTOMER');
    // Denied full-admin routes, allowed the restricted inbox.
    expect((await agent.get('/api/v1/admin/orders')).status).toBe(403);
    expect((await agent.get('/api/v1/admin/inquiries/contact')).status).toBe(200);
  });

  it('never grants the support account admin or inbox access without a verified email', async () => {
    mockAuth.verifyIdToken.mockResolvedValue({
      uid: 'uid-support-unverified',
      email: SUPPORT_EMAIL,
      email_verified: false,
    });
    mockAuth.createSessionCookie.mockResolvedValue('fb-cookie-support-unverified');
    mockAuth.verifySessionCookie.mockResolvedValue({
      uid: 'uid-support-unverified',
      email: SUPPORT_EMAIL,
      email_verified: false,
    });

    const { agent, csrfToken } = await createAgent(app);
    const res = await exchange(agent, csrfToken, 'id-token-support-unverified');
    expect(res.status).toBe(200);

    expect(mockAuth.setCustomUserClaims).not.toHaveBeenCalled();

    const me = await agent.get('/api/v1/auth/me');
    expect(me.body.data.user.role).toBe('CUSTOMER');
    expect((await agent.get('/api/v1/admin/orders')).status).toBe(403);
    // Unverified support is denied the restricted inbox too.
    expect((await agent.get('/api/v1/admin/inquiries/contact')).status).toBe(403);
  });

  it('never grants admin from a forged claim on a non-admin email', async () => {
    const email = uniqueEmail('fb-forged');
    mockAuth.verifyIdToken.mockResolvedValue({ uid: 'uid-forged', email, email_verified: true });
    mockAuth.createSessionCookie.mockResolvedValue('fb-cookie-forged');
    // The client cannot set claims; simulate a claim that exists on the wrong account.
    mockAuth.verifySessionCookie.mockResolvedValue({
      uid: 'uid-forged',
      email,
      email_verified: true,
      admin: true,
    });

    const { agent, csrfToken } = await createAgent(app);
    const res = await exchange(agent, csrfToken, 'id-token-forged');
    expect(res.status).toBe(200);

    const me = await agent.get('/api/v1/auth/me');
    expect(me.body.data.user.role).toBe('CUSTOMER');
    expect((await agent.get('/api/v1/admin/orders')).status).toBe(403);
  });

  it('never grants admin to the admin email without a verified email', async () => {
    mockAuth.verifyIdToken.mockResolvedValue({
      uid: 'uid-admin-unverified',
      email: ADMIN_EMAIL,
      email_verified: false,
    });
    mockAuth.createSessionCookie.mockResolvedValue('fb-cookie-admin-unverified');
    mockAuth.verifySessionCookie.mockResolvedValue({
      uid: 'uid-admin-unverified',
      email: ADMIN_EMAIL,
      email_verified: false,
    });

    const { agent, csrfToken } = await createAgent(app);
    const res = await exchange(agent, csrfToken, 'id-token-admin-unverified');
    expect(res.status).toBe(200);

    // No admin claim is set for an unverified email.
    expect(mockAuth.setCustomUserClaims).not.toHaveBeenCalled();

    const me = await agent.get('/api/v1/auth/me');
    expect(me.body.data.user.role).toBe('CUSTOMER');
    expect((await agent.get('/api/v1/admin/orders')).status).toBe(403);
  });

  it('clears the session on Firebase logout', async () => {
    const email = uniqueEmail('fb-logout');
    mockAuth.verifyIdToken.mockResolvedValue({ uid: 'uid-logout', email, email_verified: true });
    mockAuth.createSessionCookie.mockResolvedValue('fb-cookie-logout');
    mockAuth.verifySessionCookie.mockResolvedValue({ uid: 'uid-logout', email, email_verified: true });

    const { agent, csrfToken } = await createAgent(app);
    expect((await exchange(agent, csrfToken, 'id-token-logout')).status).toBe(200);
    expect((await agent.get('/api/v1/auth/me')).status).toBe(200);

    const out = await agent
      .post('/api/v1/auth/firebase/logout')
      .set('X-CSRF-Token', csrfToken)
      .send({});
    expect(out.status).toBe(200);
    expect(mockAuth.revokeRefreshTokens).toHaveBeenCalledWith('uid-logout');

    // After logout the revoked cookie no longer authenticates.
    mockAuth.verifySessionCookie.mockRejectedValue(new Error('revoked'));
    expect((await agent.get('/api/v1/auth/me')).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Regression: the session cookie is minted from the ID token the browser
// already holds — i.e. BEFORE syncAdminClaim writes the `admin` claim — and the
// client never force-refreshes that token. So a freshly-authorized admin's
// cookie can arrive with NO `admin` claim at all. The server must still resolve
// ADMIN from the allow-list + verified email, exactly like every other path.
// ---------------------------------------------------------------------------
describe('stale/absent admin-claim regression', () => {
  it('never resolves the support email as ADMIN, even with a stale admin claim', async () => {
    mockAuth.verifyIdToken.mockResolvedValue({
      uid: 'uid-support-stale-claim',
      email: SUPPORT_EMAIL,
      email_verified: true,
      name: 'DRAFTOX Support',
    });
    mockAuth.createSessionCookie.mockResolvedValue('fb-cookie-support-stale');
    // A stale `admin` claim on the support account must be inert (defence in
    // depth: authorization is by allow-list, not the claim).
    mockAuth.verifySessionCookie.mockResolvedValue({
      uid: 'uid-support-stale-claim',
      email: SUPPORT_EMAIL,
      email_verified: true,
      admin: true,
    });

    const { agent, csrfToken } = await createAgent(app);
    const res = await exchange(agent, csrfToken, 'id-token-support-stale');
    expect(res.status).toBe(200);
    expect(res.body.data.user.role).toBe('CUSTOMER');
    expect(mockAuth.setCustomUserClaims).not.toHaveBeenCalled();

    const me = await agent.get('/api/v1/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.data.user.role).toBe('CUSTOMER');
    // Denied full-admin, allowed the restricted inbox.
    expect((await agent.get('/api/v1/admin/orders')).status).toBe(403);
    expect((await agent.get('/api/v1/admin/inquiries/contact')).status).toBe(200);
  });

  it('grants ADMIN to the primary admin email when the cookie has no admin claim', async () => {
    mockAuth.verifyIdToken.mockResolvedValue({
      uid: 'uid-primary-stale-claim',
      email: ADMIN_EMAIL,
      email_verified: true,
      name: 'DRAFTOX Owner',
    });
    mockAuth.createSessionCookie.mockResolvedValue('fb-cookie-primary-stale');
    mockAuth.verifySessionCookie.mockResolvedValue({
      uid: 'uid-primary-stale-claim',
      email: ADMIN_EMAIL,
      email_verified: true,
    });

    const { agent, csrfToken } = await createAgent(app);
    const res = await exchange(agent, csrfToken, 'id-token-primary-stale');
    expect(res.status).toBe(200);
    expect(res.body.data.user.role).toBe('ADMIN');
    expect((await agent.get('/api/v1/auth/me')).body.data.user.role).toBe('ADMIN');
    expect((await agent.get('/api/v1/admin/orders')).status).toBe(200);
  });

  it('a stale CUSTOMER database role cannot deny an authorized, verified admin', async () => {
    const { prisma } = await import('../src/lib/prisma.js');
    await prisma.user.upsert({
      where: { email: ADMIN_EMAIL },
      update: { role: 'CUSTOMER', emailVerified: true },
      create: { name: 'DRAFTOX Owner', email: ADMIN_EMAIL, role: 'CUSTOMER', emailVerified: true },
    });

    mockAuth.verifyIdToken.mockResolvedValue({
      uid: 'uid-admin-stale-role',
      email: ADMIN_EMAIL,
      email_verified: true,
    });
    mockAuth.createSessionCookie.mockResolvedValue('fb-cookie-stale-role');
    mockAuth.verifySessionCookie.mockResolvedValue({
      uid: 'uid-admin-stale-role',
      email: ADMIN_EMAIL,
      email_verified: true,
    });

    const { agent, csrfToken } = await createAgent(app);
    expect((await exchange(agent, csrfToken, 'id-token-stale-role')).status).toBe(200);
    expect((await agent.get('/api/v1/auth/me')).body.data.user.role).toBe('ADMIN');
    expect((await agent.get('/api/v1/admin/orders')).status).toBe(200);
  });

  it('a stale ADMIN database role cannot grant an unrelated verified email', async () => {
    const { prisma } = await import('../src/lib/prisma.js');
    const email = uniqueEmail('stale-admin-role');
    await prisma.user.create({
      data: { name: 'Impostor', email, role: 'ADMIN', emailVerified: true },
    });
    try {
      mockAuth.verifyIdToken.mockResolvedValue({ uid: 'uid-stale-admin-role', email, email_verified: true });
      mockAuth.createSessionCookie.mockResolvedValue('fb-cookie-stale-admin');
      mockAuth.verifySessionCookie.mockResolvedValue({
        uid: 'uid-stale-admin-role',
        email,
        email_verified: true,
      });

      const { agent, csrfToken } = await createAgent(app);
      expect((await exchange(agent, csrfToken, 'id-token-stale-admin')).status).toBe(200);
      expect((await agent.get('/api/v1/auth/me')).body.data.user.role).toBe('CUSTOMER');
      expect((await agent.get('/api/v1/admin/orders')).status).toBe(403);
    } finally {
      await prisma.user.deleteMany({ where: { email } });
    }
  });

  it('an unverified sign-in stays CUSTOMER even if the stored row says verified', async () => {
    const { prisma } = await import('../src/lib/prisma.js');
    await prisma.user.upsert({
      where: { email: ADMIN_EMAIL },
      update: { role: 'CUSTOMER', emailVerified: true },
      create: { name: 'DRAFTOX Owner', email: ADMIN_EMAIL, role: 'CUSTOMER', emailVerified: true },
    });

    // Token says the email is NOT verified; the stale stored flag must not grant.
    mockAuth.verifyIdToken.mockResolvedValue({
      uid: 'uid-admin-unverified-v2',
      email: ADMIN_EMAIL,
      email_verified: false,
    });
    mockAuth.createSessionCookie.mockResolvedValue('fb-cookie-unverified-v2');
    mockAuth.verifySessionCookie.mockResolvedValue({
      uid: 'uid-admin-unverified-v2',
      email: ADMIN_EMAIL,
      email_verified: false,
    });

    const { agent, csrfToken } = await createAgent(app);
    const res = await exchange(agent, csrfToken, 'id-token-unverified-v2');
    expect(res.status).toBe(200);
    expect(res.body.data.user.role).toBe('CUSTOMER');
    expect(mockAuth.setCustomUserClaims).not.toHaveBeenCalled();
    expect((await agent.get('/api/v1/auth/me')).body.data.user.role).toBe('CUSTOMER');
    expect((await agent.get('/api/v1/admin/orders')).status).toBe(403);
  });
});
