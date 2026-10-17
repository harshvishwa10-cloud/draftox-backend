// Imported FIRST (before any module that loads src/config/env.ts) so that
// Razorpay appears configured for the payments test file only. The global test
// env keeps Razorpay disabled, so unconfigured behaviour stays covered in
// orders.test.ts.
process.env.RAZORPAY_KEY_ID = 'rzp_test_dummykey0001';
process.env.RAZORPAY_KEY_SECRET = 'dummy_key_secret_for_tests';
process.env.RAZORPAY_WEBHOOK_SECRET = 'dummy_webhook_secret_for_tests';

export {};
