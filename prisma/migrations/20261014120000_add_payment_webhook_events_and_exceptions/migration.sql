-- Durable webhook event log: inserted before processing so an accepted event is
-- never silently dropped, and deduplicated on the Razorpay event id (or a body
-- hash) so retries are idempotent.
CREATE TYPE "WebhookEventStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED');

CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventType" TEXT,
    "status" "WebhookEventStatus" NOT NULL DEFAULT 'RECEIVED',
    "razorpayOrderId" TEXT,
    "razorpayPaymentId" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WebhookEvent_eventId_key" ON "WebhookEvent"("eventId");
CREATE INDEX "WebhookEvent_status_idx" ON "WebhookEvent"("status");
CREATE INDEX "WebhookEvent_eventType_idx" ON "WebhookEvent"("eventType");
CREATE INDEX "WebhookEvent_razorpayOrderId_idx" ON "WebhookEvent"("razorpayOrderId");
CREATE INDEX "WebhookEvent_receivedAt_idx" ON "WebhookEvent"("receivedAt");

-- Payments that need a human look (unmatched/mismatched/cancelled/duplicate or a
-- failed webhook). No FK to Order: the audit trail must survive order removal.
CREATE TYPE "PaymentExceptionKind" AS ENUM ('UNMATCHED_PAYMENT', 'AMOUNT_MISMATCH', 'CURRENCY_MISMATCH', 'CANCELLED_PAYMENT', 'DUPLICATE_PAYMENT', 'WEBHOOK_FAILED', 'RECONCILE_FAILED');
CREATE TYPE "PaymentExceptionStatus" AS ENUM ('OPEN', 'RESOLVED');

CREATE TABLE "PaymentException" (
    "id" TEXT NOT NULL,
    "kind" "PaymentExceptionKind" NOT NULL,
    "status" "PaymentExceptionStatus" NOT NULL DEFAULT 'OPEN',
    "orderId" TEXT,
    "razorpayOrderId" TEXT,
    "razorpayPaymentId" TEXT,
    "amount" DECIMAL(12,2),
    "currency" TEXT,
    "reason" TEXT NOT NULL,
    "details" JSONB,
    "webhookEventId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "resolutionNote" TEXT,

    CONSTRAINT "PaymentException_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PaymentException_webhookEventId_key" ON "PaymentException"("webhookEventId");
CREATE INDEX "PaymentException_status_idx" ON "PaymentException"("status");
CREATE INDEX "PaymentException_kind_idx" ON "PaymentException"("kind");
CREATE INDEX "PaymentException_orderId_idx" ON "PaymentException"("orderId");
CREATE INDEX "PaymentException_createdAt_idx" ON "PaymentException"("createdAt");
