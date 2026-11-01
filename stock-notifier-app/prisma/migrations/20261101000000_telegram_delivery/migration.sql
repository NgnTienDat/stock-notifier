ALTER TABLE "InventoryAlert"
  ADD COLUMN "notificationChatId" TEXT,
  ADD COLUMN "notificationText" TEXT,
  ADD COLUMN "notificationAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "notificationNextAttemptAt" TIMESTAMPTZ(3),
  ADD COLUMN "notificationLeaseUntil" TIMESTAMPTZ(3),
  ADD COLUMN "notificationLeaseToken" TEXT,
  ADD COLUMN "notificationError" TEXT;

CREATE INDEX "InventoryAlert_notificationNextAttemptAt_idx"
  ON "InventoryAlert" ("notificationNextAttemptAt");
