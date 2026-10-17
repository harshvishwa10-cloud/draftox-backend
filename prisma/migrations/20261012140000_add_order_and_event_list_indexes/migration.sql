-- Add composite indexes for the two heaviest read paths:
--
--  1. Customer order history (GET /my-orders, GET /orders):
--     WHERE userId = ? ORDER BY createdAt DESC  → Order(userId, createdAt)
--
--  2. Admin filtered order lists (payment + fulfilment status, newest first):
--     WHERE status = ?         ORDER BY createdAt DESC → Order(status, createdAt)
--     WHERE fulfillmentStatus = ? ORDER BY createdAt DESC → Order(fulfillmentStatus, createdAt)
--
--  3. Order timeline rendering (GET /admin/orders/:id, order detail):
--     WHERE orderId = ? ORDER BY createdAt ASC → OrderEvent(orderId, createdAt)
--
-- All statements are additive and idempotent (IF NOT EXISTS), following the
-- drift-reconciliation pattern already used in this project: they are safe on
-- both fully-migrated and previously-drifted databases, and touch no data.
CREATE INDEX IF NOT EXISTS "Order_userId_createdAt_idx" ON "Order"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "Order_status_createdAt_idx" ON "Order"("status", "createdAt");
CREATE INDEX IF NOT EXISTS "Order_fulfillmentStatus_createdAt_idx" ON "Order"("fulfillmentStatus", "createdAt");
CREATE INDEX IF NOT EXISTS "OrderEvent_orderId_createdAt_idx" ON "OrderEvent"("orderId", "createdAt");