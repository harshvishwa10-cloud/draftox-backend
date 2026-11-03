-- Delivery confirmation workflow.
--
-- Purely additive enum values: no table, column or existing row is modified.
-- DELIVERY_CONFIRMED shipment emails are made idempotent through the existing
-- unique `idempotencyKey` column (one automatic confirmation per order), while a
-- deliberate admin resend can create a new keyed row.
ALTER TYPE "OrderEventType" ADD VALUE IF NOT EXISTS 'DELIVERY_CONFIRMED';
ALTER TYPE "ShipmentNotificationType" ADD VALUE IF NOT EXISTS 'DELIVERY_CONFIRMED';
