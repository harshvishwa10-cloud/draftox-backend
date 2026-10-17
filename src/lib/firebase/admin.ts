/**
 * Lazy Firebase Admin (Authentication) initialization.
 *
 * Design goals:
 * - The API must boot even when Firebase is NOT configured. `getFirebaseAuth()`
 *   returns `null` in that case and the caller keeps using the pre-existing
 *   session path.
 * - Credentials are read only from server-side environment configuration and
 *   are NEVER logged, serialized into a response, or exposed to the frontend.
 * - The standard `FIREBASE_AUTH_EMULATOR_HOST` variable (read directly by the
 *   Admin SDK) enables local/emulator use without real credentials.
 */
import { cert, getApp, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth, type Auth } from 'firebase-admin/auth';
import { env, firebaseConfigured } from '../../config/env.js';

interface ServiceAccount {
  projectId: string;
  clientEmail: string;
  privateKey: string;
}

let cachedAuth: Auth | null = null;

/** True when a Firebase Auth emulator is targeted (test/dev only). */
const usingEmulator = Boolean(env.FIREBASE_AUTH_EMULATOR_HOST);

/**
 * Firebase Auth is usable when real Admin credentials exist OR an emulator is
 * targeted (the emulator accepts unsigned/local tokens without a service
 * account). This is the single gate the middleware/controllers consult.
 */
export const firebaseAdminAvailable = firebaseConfigured || usingEmulator;

function loadServiceAccount(): ServiceAccount | null {
  if (env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    try {
      const raw = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON) as Partial<ServiceAccount>;
      if (raw.projectId && raw.clientEmail && raw.privateKey) {
        return {
          projectId: raw.projectId,
          clientEmail: raw.clientEmail,
          // Stored one-line in env with escaped newlines; restore real newlines.
          privateKey: raw.privateKey.replace(/\\n/g, '\n'),
        };
      }
      return null;
    } catch {
      return null;
    }
  }
  if (env.FIREBASE_PROJECT_ID && env.FIREBASE_CLIENT_EMAIL && env.FIREBASE_PRIVATE_KEY) {
    return {
      projectId: env.FIREBASE_PROJECT_ID,
      clientEmail: env.FIREBASE_CLIENT_EMAIL,
      privateKey: env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    };
  }
  return null;
}

/**
 * Returns a memoized Firebase `Auth` instance, or `null` when Firebase is not
 * available. Never throws on missing configuration.
 */
export function getFirebaseAuth(): Auth | null {
  if (!firebaseAdminAvailable) return null;
  if (cachedAuth) return cachedAuth;

  const account = loadServiceAccount();
  const existing = getApps();
  const app = existing.length
    ? getApp()
    : initializeApp(
        account
          ? { credential: cert(account), projectId: account.projectId }
          : { projectId: env.FIREBASE_PROJECT_ID ?? 'demo-draftox' },
      );

  cachedAuth = getAuth(app);
  return cachedAuth;
}

/** Test seam: forget the memoized instance (used by unit tests). */
export function __resetFirebaseAdminForTests(): void {
  cachedAuth = null;
}
