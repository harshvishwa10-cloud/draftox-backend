-- Single-administrator authorization support.
--
-- 1) Track whether the account's email was verified by a trusted identity
--    provider (Google OAuth). Administrator access requires this flag, so it
--    can never be granted from a client-supplied value or a database role.
ALTER TABLE "User" ADD COLUMN "emailVerified" BOOLEAN NOT NULL DEFAULT false;

-- 2) Revoke administrator access from every account other than the single
--    authorized admin. Non-destructive: only the "role" column is changed, so
--    customer accounts, orders, addresses and history are all preserved.
UPDATE "User"
SET "role" = 'CUSTOMER'
WHERE "role" = 'ADMIN'
  AND lower("email") <> 'draftox0@gmail.com';
