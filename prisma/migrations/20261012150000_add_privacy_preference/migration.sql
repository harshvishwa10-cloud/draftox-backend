-- Additive, idempotent introduction of the per-account communication
-- preference table. Written to be safe on already-migrated/drifted databases:
-- CREATE TABLE / CREATE INDEX use IF NOT EXISTS, and the FK uses a guarded
-- ALTER so applying this migration twice is harmless.

CREATE TABLE IF NOT EXISTS "PrivacyPreference" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "marketingEmail" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PrivacyPreference_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PrivacyPreference_userId_key" ON "PrivacyPreference"("userId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PrivacyPreference_userId_fkey') THEN
    ALTER TABLE "PrivacyPreference"
      ADD CONSTRAINT "PrivacyPreference_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;