// Imported FIRST (before any module that loads src/config/env.ts) so the Brevo
// HTTP transport is active for this test file only. The global test env keeps
// BREVO_API_KEY empty (EMAIL_PROVIDER=none), so the SMTP/disabled paths stay
// covered elsewhere. global.fetch is mocked in the test file, so no real
// network is touched and no real email can be sent.
//
// Admin and business recipients are deliberately DISTINCT here so the test can
// prove all three order-notification flows are addressed independently.
process.env.BREVO_API_KEY = 'xkeysib-test-do-not-log-order-0001';
process.env.EMAIL_PROVIDER = 'none';
process.env.EMAIL_FROM = 'DRAFTox <harshvishwa10@gmail.com>';
process.env.EMAIL_FROM_NAME = 'DRAFTOX';
process.env.OWNER_NOTIFICATION_EMAIL = 'draftox0@gmail.com';
process.env.SUPPORT_EMAIL = 'draftoxcustomersupport@gmail.com';

export {};
