-- Customer-facing 5-digit order number. Stored as TEXT so a leading zero could
-- be preserved; uniqueness is enforced by a database index, not app code.
ALTER TABLE "Order" ADD COLUMN "orderNumber" TEXT;

-- Provider-reported payment instrument (upi/card/netbanking/...), set when a
-- payment is verified. Shown on the order detail page when reliably available.
ALTER TABLE "Order" ADD COLUMN "paymentMethod" TEXT;

-- Enforce uniqueness at the database level (multiple NULLs are allowed for any
-- legacy rows, but every order created by the app always carries a number).
CREATE UNIQUE INDEX "Order_orderNumber_key" ON "Order"("orderNumber");

-- Single-row atomic allocator for order numbers. Its value is incremented
-- inside the order-creation transaction so concurrent checkouts are serialised.
CREATE TABLE "OrderCounter" (
    "key" TEXT NOT NULL,
    "value" INTEGER NOT NULL,

    CONSTRAINT "OrderCounter_pkey" PRIMARY KEY ("key")
);

INSERT INTO "OrderCounter" ("key", "value") VALUES ('order_number', 9999);

-- Backfill existing orders oldest-first so historical orders also carry a
-- number. Non-destructive: only fills rows where orderNumber is still NULL.
WITH numbered AS (
    SELECT "id", (9999 + ROW_NUMBER() OVER (ORDER BY "createdAt" ASC, "id" ASC)) AS n
    FROM "Order"
    WHERE "orderNumber" IS NULL
)
UPDATE "Order"
SET "orderNumber" = numbered.n::text
FROM numbered
WHERE "Order"."id" = numbered."id";

-- Advance the allocator past every number already handed out so new orders can
-- never collide with a backfilled one.
UPDATE "OrderCounter"
SET "value" = (SELECT COALESCE(MAX("orderNumber"::integer), 9999) FROM "Order")
WHERE "key" = 'order_number';
