import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import db from "../../db.server";

export const MAX_NOTIFICATION_ATTEMPTS = 3;
type Claim = {
  id: string;
  token: string;
  chatId: string;
  text: string;
  attempt: number;
};

const eligible = Prisma.sql`
  a."status" = 'ACTIVE' AND a."notificationChatId" IS NOT NULL AND a."notificationText" IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM "InventoryLevel" i JOIN "ShopSettings" s ON s."shopDomain" = i."shopDomain"
    WHERE i.id = a."inventoryLevelId" AND i."isCurrent" AND i."isLowStock"
      AND i."locationGid" = s."locationGid" AND s."lastSyncedAt" IS NOT NULL
      AND s."telegramChatId" = a."notificationChatId"
      AND EXISTS (SELECT 1 FROM "Session" se WHERE se.shop = s."shopDomain" AND NOT se."isOnline")
  )`;

export function claimNotification(shopDomain: string) {
  return db.$transaction(async (tx) => {
    // NULL nextAttemptAt is intentionally unscheduled, including all pre-migration alerts.
    await tx.$executeRaw`
      UPDATE "InventoryAlert" a SET "notificationStatus" = 'FAILED',
        "notificationNextAttemptAt" = NULL, "notificationLeaseUntil" = NULL, "notificationLeaseToken" = NULL,
        "notificationError" = 'Notification no longer eligible or retry limit reached.'
      WHERE a."notificationNextAttemptAt" IS NOT NULL AND a."notificationStatus" <> 'SENT'
        AND (a."notificationLeaseUntil" IS NULL OR a."notificationLeaseUntil" <= NOW())
        AND EXISTS (SELECT 1 FROM "InventoryLevel" i WHERE i.id = a."inventoryLevelId" AND i."shopDomain" = ${shopDomain})
        AND (a."notificationAttempts" >= ${MAX_NOTIFICATION_ATTEMPTS} OR NOT (${eligible}))
    `;
    const [claim] = await tx.$queryRaw<Claim[]>`
      WITH candidate AS (
        SELECT a.id FROM "InventoryAlert" a
        WHERE a."notificationNextAttemptAt" <= NOW() AND a."notificationStatus" <> 'SENT'
          AND a."notificationAttempts" < ${MAX_NOTIFICATION_ATTEMPTS}
          AND (a."notificationLeaseUntil" IS NULL OR a."notificationLeaseUntil" <= NOW())
          AND EXISTS (SELECT 1 FROM "InventoryLevel" i WHERE i.id = a."inventoryLevelId" AND i."shopDomain" = ${shopDomain})
          AND ${eligible}
        ORDER BY a."notificationNextAttemptAt", a."triggeredAt", a.id LIMIT 1 FOR UPDATE OF a SKIP LOCKED
      )
      UPDATE "InventoryAlert" a SET "notificationAttempts" = a."notificationAttempts" + 1,
        "notificationLeaseToken" = ${randomUUID()}, "notificationLeaseUntil" = NOW() + INTERVAL '30 seconds',
        "notificationStatus" = 'PENDING'
      FROM candidate c WHERE a.id = c.id
      RETURNING a.id, a."notificationLeaseToken" AS token, a."notificationChatId" AS "chatId",
        a."notificationText" AS text, a."notificationAttempts" AS attempt
    `;
    return claim ?? null;
  });
}

export async function isNotificationEligible(shopDomain: string, claim: Claim) {
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT a.id FROM "InventoryAlert" a WHERE a.id = ${claim.id}
      AND a."notificationLeaseToken" = ${claim.token} AND a."notificationLeaseUntil" > NOW()
      AND EXISTS (SELECT 1 FROM "InventoryLevel" i WHERE i.id = a."inventoryLevelId" AND i."shopDomain" = ${shopDomain})
      AND ${eligible}
  `;
  return rows.length === 1;
}

export async function finishNotification(
  shopDomain: string,
  claim: Claim,
  failure?: { message: string; retryable: boolean; retryAfterMs: number },
) {
  const retry = Boolean(
    failure?.retryable && claim.attempt < MAX_NOTIFICATION_ATTEMPTS,
  );
  const delayMs = Math.max(
    claim.attempt === 1 ? 5000 : 30000,
    failure?.retryAfterMs ?? 0,
  );
  // Use the same database clock for claim, lease fencing and retry scheduling.
  const count = await db.$executeRaw`
    UPDATE "InventoryAlert" a SET
      "notificationStatus" = CAST(${failure ? "FAILED" : "SENT"} AS "NotificationStatus"),
      "notifiedAt" = CASE WHEN ${!failure} THEN NOW() ELSE a."notifiedAt" END,
      "notificationError" = ${failure?.message ?? null},
      "notificationNextAttemptAt" = CASE WHEN ${retry} THEN NOW() + ${delayMs} * INTERVAL '1 millisecond' ELSE NULL END,
      "notificationLeaseToken" = NULL, "notificationLeaseUntil" = NULL
    WHERE a.id = ${claim.id} AND a."notificationLeaseToken" = ${claim.token}
      AND a."notificationLeaseUntil" > NOW()
      AND EXISTS (SELECT 1 FROM "InventoryLevel" i WHERE i.id = a."inventoryLevelId" AND i."shopDomain" = ${shopDomain})
  `;
  return { count };
}
