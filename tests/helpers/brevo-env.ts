// Imported FIRST (before any module that loads src/config/env.ts) so that the
// Brevo transport appears configured for this test file only. The global test
// env keeps BREVO_API_KEY empty (EMAIL_PROVIDER=none), so the SMTP/disabled
// paths stay covered elsewhere. global.fetch is mocked in the test file, so no
// real network is touched.
process.env.BREVO_API_KEY = 'xkeysib-test-do-not-log-contact-0001';
process.env.EMAIL_PROVIDER = 'none';
process.env.EMAIL_FROM = 'DRAFTox <harshvishwa10@gmail.com>';
process.env.EMAIL_FROM_NAME = 'DRAFTOX';
process.env.OWNER_NOTIFICATION_EMAIL = 'draftoxcustomersupport@gmail.com';

export {};
