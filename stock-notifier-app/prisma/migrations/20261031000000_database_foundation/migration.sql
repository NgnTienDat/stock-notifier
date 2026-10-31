-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "AlertStatus" AS ENUM ('ACTIVE', 'RESOLVED');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopSettings" (
    "shopDomain" TEXT NOT NULL,
    "locationGid" TEXT,
    "locationName" TEXT,
    "telegramChatId" TEXT,
    "lastSyncedAt" TIMESTAMPTZ(3),
    "lowStockThreshold" INTEGER NOT NULL DEFAULT 5,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ShopSettings_pkey" PRIMARY KEY ("shopDomain")
);

-- CreateTable
CREATE TABLE "InventoryLevel" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "locationGid" TEXT NOT NULL,
    "inventoryItemGid" TEXT NOT NULL,
    "variants" JSONB NOT NULL,
    "sku" TEXT,
    "availableQuantity" INTEGER NOT NULL,
    "isLowStock" BOOLEAN NOT NULL,
    "isCurrent" BOOLEAN NOT NULL DEFAULT true,
    "shopifyUpdatedAt" TIMESTAMPTZ(3),
    "syncedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventoryLevel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryAlert" (
    "id" TEXT NOT NULL,
    "inventoryLevelId" TEXT NOT NULL,
    "quantityAtTrigger" INTEGER NOT NULL,
    "thresholdAtTrigger" INTEGER NOT NULL,
    "status" "AlertStatus" NOT NULL DEFAULT 'ACTIVE',
    "notificationStatus" "NotificationStatus" NOT NULL DEFAULT 'PENDING',
    "triggeredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMPTZ(3),
    "notifiedAt" TIMESTAMPTZ(3),

    CONSTRAINT "InventoryAlert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "webhookId" TEXT NOT NULL,
    "processedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InventoryLevel_shopDomain_locationGid_inventoryItemGid_key" ON "InventoryLevel"("shopDomain", "locationGid", "inventoryItemGid");

-- CreateIndex
CREATE INDEX "InventoryAlert_inventoryLevelId_idx" ON "InventoryAlert"("inventoryLevelId");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_shopDomain_webhookId_key" ON "WebhookEvent"("shopDomain", "webhookId");

-- AddForeignKey
ALTER TABLE "InventoryLevel" ADD CONSTRAINT "InventoryLevel_shopDomain_fkey" FOREIGN KEY ("shopDomain") REFERENCES "ShopSettings"("shopDomain") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryAlert" ADD CONSTRAINT "InventoryAlert_inventoryLevelId_fkey" FOREIGN KEY ("inventoryLevelId") REFERENCES "InventoryLevel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookEvent" ADD CONSTRAINT "WebhookEvent_shopDomain_fkey" FOREIGN KEY ("shopDomain") REFERENCES "ShopSettings"("shopDomain") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Prisma 6 cannot represent these constraints; keep them in migration SQL.
ALTER TABLE "ShopSettings" ADD CONSTRAINT "ShopSettings_lowStockThreshold_check" CHECK ("lowStockThreshold" >= 0);

CREATE UNIQUE INDEX "InventoryAlert_one_active_per_level"
ON "InventoryAlert" ("inventoryLevelId") WHERE "status" = 'ACTIVE';
