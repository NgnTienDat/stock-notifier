BEGIN;

CREATE TYPE "LocationSyncStatus" AS ENUM ('PENDING', 'READY');

CREATE TABLE "MonitoredLocation" (
    "shopDomain" TEXT NOT NULL,
    "locationGid" TEXT NOT NULL,
    "locationName" TEXT,
    "isActive" BOOLEAN,
    "syncStatus" "LocationSyncStatus" NOT NULL DEFAULT 'PENDING',
    "baselineCompletedAt" TIMESTAMPTZ(3),
    "lastSyncedAt" TIMESTAMPTZ(3),
    "version" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "MonitoredLocation_pkey" PRIMARY KEY ("shopDomain", "locationGid"),
    CONSTRAINT "MonitoredLocation_shopDomain_fkey" FOREIGN KEY ("shopDomain")
        REFERENCES "ShopSettings"("shopDomain") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- lastSyncedAt proves a previous baseline, not current Shopify location activity.
INSERT INTO "MonitoredLocation" (
    "shopDomain", "locationGid", "locationName", "isActive", "syncStatus",
    "baselineCompletedAt", "lastSyncedAt", "version", "createdAt", "updatedAt"
)
SELECT "shopDomain", "locationGid", "locationName", NULL,
    CASE WHEN "lastSyncedAt" IS NULL THEN 'PENDING'::"LocationSyncStatus"
         ELSE 'READY'::"LocationSyncStatus" END,
    "lastSyncedAt", "lastSyncedAt", 0, "createdAt", "updatedAt"
FROM "ShopSettings"
WHERE "locationGid" IS NOT NULL
ON CONFLICT ("shopDomain", "locationGid") DO NOTHING;

COMMIT;
