// Imported FIRST (before any module that loads src/config/env.ts) so the
// master ordering switch reads DISABLED for this test file only. The global
// test env keeps ordering enabled (setup-env.ts), so the normal order flow
// stays covered in orders.test.ts / payments.test.ts.
process.env.STORE_ORDERS_ENABLED = 'false';

export {};