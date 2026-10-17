-- Add an optional idempotency key for explicit (UPDATE) shipment emails so a
-- repeated/retried request can never send a duplicate. NULL is allowed for the
-- automatic INITIAL row (its uniqueness is enforced by the partial index).
--
-- This migration also reconciles drift: some environments recorded the
-- `20261012120000_shipment_tracking_and_notifications` migration before its
-- `messageId` column was added, leaving the live table without it. IF NOT EXISTS
-- makes every statement safe on both drifted and up-to-date databases, and is
-- strictly additive (no data is touched).
ALTER TABLE "ShipmentNotification" ADD COLUMN IF NOT EXISTS "messageId" TEXT;
ALTER TABLE "ShipmentNotification" ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "ShipmentNotification_idempotencyKey_key"
    ON "ShipmentNotification"("idempotencyKey");
