-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('REQUESTED', 'PROCESSING', 'SUCCESS', 'FAILED', 'MANUAL_REVIEW');

-- CreateEnum
CREATE TYPE "ReturnReason" AS ENUM ('DEFECTIVE', 'NOT_AS_DESCRIBED', 'DAMAGED_IN_TRANSIT', 'WRONG_ITEM', 'OTHER');

-- CreateEnum
CREATE TYPE "ReturnStatus" AS ENUM ('SUBMITTED', 'APPROVED', 'REJECTED', 'ITEM_RECEIVED', 'REFUND_INITIATED', 'REFUND_COMPLETED', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "OrderNotificationType" AS ENUM ('ORDER_CANCELLED', 'RETURN_SUBMITTED', 'RETURN_DECISION');

-- CreateEnum
CREATE TYPE "OrderNotificationStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "OrderEventType" ADD VALUE 'ORDER_CANCELLED_BY_CUSTOMER';
ALTER TYPE "OrderEventType" ADD VALUE 'REFUND_INITIATED';
ALTER TYPE "OrderEventType" ADD VALUE 'REFUND_UPDATED';
ALTER TYPE "OrderEventType" ADD VALUE 'REFUND_COMPLETED';
ALTER TYPE "OrderEventType" ADD VALUE 'REFUND_FAILED';
ALTER TYPE "OrderEventType" ADD VALUE 'RETURN_REQUESTED';
ALTER TYPE "OrderEventType" ADD VALUE 'RETURN_REVIEWED';
ALTER TYPE "OrderEventType" ADD VALUE 'RETURN_RESOLVED';

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "warrantyMonths" INTEGER;

-- AlterTable
ALTER TABLE "Shipment" ADD COLUMN     "deliveredAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "Refund" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "status" "RefundStatus" NOT NULL DEFAULT 'REQUESTED',
    "provider" TEXT,
    "idempotencyKey" TEXT,
    "providerRefundId" TEXT,
    "error" TEXT,
    "initiatedBy" TEXT,
    "initiatedById" TEXT,
    "initiatedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Refund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReturnRequest" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "userId" TEXT,
    "reason" "ReturnReason" NOT NULL,
    "explanation" TEXT NOT NULL,
    "status" "ReturnStatus" NOT NULL DEFAULT 'SUBMITTED',
    "needsReview" BOOLEAN NOT NULL DEFAULT false,
    "photos" JSONB NOT NULL,
    "decidedBy" TEXT,
    "decidedById" TEXT,
    "decisionNote" TEXT,
    "decidedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReturnRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderNotification" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "returnRequestId" TEXT,
    "type" "OrderNotificationType" NOT NULL,
    "status" "OrderNotificationStatus" NOT NULL DEFAULT 'PENDING',
    "toEmail" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "provider" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "messageId" TEXT,
    "error" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderNotification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Refund_orderId_key" ON "Refund"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "Refund_idempotencyKey_key" ON "Refund"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "Refund_providerRefundId_key" ON "Refund"("providerRefundId");

-- CreateIndex
CREATE INDEX "Refund_status_idx" ON "Refund"("status");

-- CreateIndex
CREATE INDEX "Refund_createdAt_idx" ON "Refund"("createdAt");

-- CreateIndex
CREATE INDEX "ReturnRequest_orderId_idx" ON "ReturnRequest"("orderId");

-- CreateIndex
CREATE INDEX "ReturnRequest_status_idx" ON "ReturnRequest"("status");

-- CreateIndex
CREATE INDEX "ReturnRequest_createdAt_idx" ON "ReturnRequest"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "OrderNotification_idempotencyKey_key" ON "OrderNotification"("idempotencyKey");

-- CreateIndex
CREATE INDEX "OrderNotification_orderId_idx" ON "OrderNotification"("orderId");

-- CreateIndex
CREATE INDEX "OrderNotification_status_idx" ON "OrderNotification"("status");

-- CreateIndex
CREATE INDEX "OrderNotification_createdAt_idx" ON "OrderNotification"("createdAt");

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturnRequest" ADD CONSTRAINT "ReturnRequest_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturnRequest" ADD CONSTRAINT "ReturnRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderNotification" ADD CONSTRAINT "OrderNotification_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderNotification" ADD CONSTRAINT "OrderNotification_returnRequestId_fkey" FOREIGN KEY ("returnRequestId") REFERENCES "ReturnRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;
