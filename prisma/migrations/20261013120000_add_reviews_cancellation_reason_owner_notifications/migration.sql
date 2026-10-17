-- Customer cancellation reason (required on the cancel flow; mirrored to event metadata).
CREATE TYPE "CancellationReason" AS ENUM ('CHANGED_MIND', 'ORDERED_BY_MISTAKE', 'FOUND_BETTER_PRICE', 'DELIVERY_TOO_SLOW', 'DUPLICATE_ORDER', 'PAYMENT_ISSUE', 'OTHER');
ALTER TABLE "Order" ADD COLUMN "cancellationReason" "CancellationReason";
ALTER TABLE "Order" ADD COLUMN "cancellationReasonNote" TEXT;

-- Optional post-order review (one per order, owning signed-in user only).
CREATE TABLE "Review" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "title" TEXT,
    "body" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Review_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Review_orderId_key" ON "Review"("orderId");
CREATE INDEX "Review_userId_idx" ON "Review"("userId");
CREATE INDEX "Review_rating_idx" ON "Review"("rating");
CREATE INDEX "Review_createdAt_idx" ON "Review"("createdAt");

ALTER TABLE "Review"
    ADD CONSTRAINT "Review_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Review"
    ADD CONSTRAINT "Review_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Store-owner notification outbox for new public requests.
CREATE TYPE "InquiryKind" AS ENUM ('CONTACT', 'PRODUCT', 'SUPPORT');
CREATE TYPE "InquiryNotificationStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

CREATE TABLE "InquiryNotification" (
    "id" TEXT NOT NULL,
    "kind" "InquiryKind" NOT NULL,
    "refId" TEXT NOT NULL,
    "toEmail" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "status" "InquiryNotificationStatus" NOT NULL DEFAULT 'PENDING',
    "idempotencyKey" TEXT,
    "provider" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "messageId" TEXT,
    "error" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "InquiryNotification_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "InquiryNotification_idempotencyKey_key" ON "InquiryNotification"("idempotencyKey");
CREATE INDEX "InquiryNotification_kind_refId_idx" ON "InquiryNotification"("kind", "refId");
CREATE INDEX "InquiryNotification_status_idx" ON "InquiryNotification"("status");
CREATE INDEX "InquiryNotification_createdAt_idx" ON "InquiryNotification"("createdAt");
