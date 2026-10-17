// Enables Google OAuth for tests that exercise the real callback route with a
// mocked identity verifier. Must be imported FIRST so src/config/env.ts sees a
// fully-configured Google provider (tests/setup-env.ts blanks it by default).
process.env.GOOGLE_CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
process.env.GOOGLE_CALLBACK_URL = 'http://localhost:4000/api/v1/auth/google/callback';

export {};
