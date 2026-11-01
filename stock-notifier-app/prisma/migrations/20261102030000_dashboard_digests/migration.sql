BEGIN;
CREATE TYPE "DigestStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'CANCELLED');
ALTER TABLE "MonitoredLocation" ADD COLUMN "lastSyncAttemptAt" TIMESTAMPTZ(3), ADD COLUMN "lastSyncError" TEXT;
CREATE TABLE "NotificationDigest" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "shopDomain" TEXT NOT NULL REFERENCES "ShopSettings"("shopDomain") ON DELETE RESTRICT ON UPDATE CASCADE,
  "batchKey" TEXT NOT NULL, "origin" "AlertOrigin" NOT NULL,
  "chatId" TEXT NOT NULL, "oldThreshold" INTEGER, "newThreshold" INTEGER NOT NULL,
  "locations" JSONB NOT NULL, "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "availableAt" TIMESTAMPTZ(3) NOT NULL, "closedAt" TIMESTAMPTZ(3),
  "status" "DigestStatus" NOT NULL DEFAULT 'PENDING', "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMPTZ(3), "leaseUntil" TIMESTAMPTZ(3), "leaseToken" TEXT,
  "notifiedAt" TIMESTAMPTZ(3), "text" TEXT, "error" TEXT,
  CONSTRAINT "NotificationDigest_origin_check" CHECK ("origin" IN ('BASELINE','THRESHOLD_CHANGE'))
);
CREATE UNIQUE INDEX "NotificationDigest_shopDomain_batchKey_key" ON "NotificationDigest"("shopDomain","batchKey");
CREATE INDEX "NotificationDigest_nextAttemptAt_idx" ON "NotificationDigest"("nextAttemptAt");
ALTER TABLE "InventoryAlert" ADD COLUMN "digestId" TEXT REFERENCES "NotificationDigest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "InventoryAlert_digestId_idx" ON "InventoryAlert"("digestId");
-- Deliberately no backfill: historical PENDING alerts never enter a delivery batch.
COMMIT;
