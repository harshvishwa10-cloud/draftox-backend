-- Cash on Delivery + idempotent order creation.
-- Order.idempotencyKey lets a retried checkout resolve to the same order.
ALTER TABLE "Order" ADD COLUMN "idempotencyKey" TEXT;
CREATE UNIQUE INDEX "Order_idempotencyKey_key" ON "Order"("idempotencyKey");

-- New order-email type for the COD confirmation sent right after creation.
ALTER TYPE "OrderNotificationType" ADD VALUE 'ORDER_CONFIRMED';
