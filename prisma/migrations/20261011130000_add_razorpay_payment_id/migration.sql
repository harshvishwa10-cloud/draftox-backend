-- Record the verified Razorpay payment id on the order so that repeated
-- verifications/webhooks are idempotent and never create duplicate payments.
ALTER TABLE "Order" ADD COLUMN "razorpayPaymentId" TEXT;

CREATE UNIQUE INDEX "Order_razorpayPaymentId_key" ON "Order"("razorpayPaymentId");
