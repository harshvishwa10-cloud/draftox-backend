-- Shipment tracking page token (opaque, stable, unique bearer secret).
ALTER TABLE "Shipment" ADD COLUMN "trackingToken" TEXT;
ALTER TABLE "Shipment" ADD COLUMN "trackingTokenCreatedAt" TIMESTAMP(3);
CREATE UNIQUE INDEX "Shipment_trackingToken_key" ON "Shipment"("trackingToken");

-- Shipment email outbox.
CREATE TYPE "ShipmentNotificationType" AS ENUM ('INITIAL', 'UPDATE');
CREATE TYPE "ShipmentNotificationStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

CREATE TABLE "ShipmentNotification" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "shipmentId" TEXT,
    "type" "ShipmentNotificationType" NOT NULL,
    "status" "ShipmentNotificationStatus" NOT NULL DEFAULT 'PENDING',
    "toEmail" TEXT NOT NULL,
    "provider" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "messageId" TEXT,
    "error" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ShipmentNotification_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ShipmentNotification_orderId_idx" ON "ShipmentNotification"("orderId");
CREATE INDEX "ShipmentNotification_status_idx" ON "ShipmentNotification"("status");
CREATE INDEX "ShipmentNotification_createdAt_idx" ON "ShipmentNotification"("createdAt");

ALTER TABLE "ShipmentNotification"
    ADD CONSTRAINT "ShipmentNotification_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ShipmentNotification"
    ADD CONSTRAINT "ShipmentNotification_shipmentId_fkey"
    FOREIGN KEY ("shipmentId") REFERENCES "Shipment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- At most one INITIAL shipment email per order (idempotent automatic email).
CREATE UNIQUE INDEX "ShipmentNotification_initial_per_order_key"
    ON "ShipmentNotification"("orderId")
    WHERE "type" = 'INITIAL';
