import { randomUUID } from "node:crypto";
import {
  Prisma,
  type AlertOrigin,
  type NotificationDigest,
} from "@prisma/client";
import db from "../../db.server";
import { MAX_NOTIFICATION_ATTEMPTS } from "./notification.repository.server";

export type DigestOperation = { key: string; oldThreshold: number };
export type DigestClaim = NotificationDigest & { leaseToken: string };

// Called only after creating a new alert, inside the inventory/threshold transaction.
export async function attachDigest(
  tx: Prisma.TransactionClient,
  settings: {
    shopDomain: string;
    telegramChatId?: string | null;
    lowStockThreshold: number;
  },
  inventoryLevelId: string,
  origin: AlertOrigin,
  operation?: DigestOperation,
) {
  if (
    origin === "INVENTORY_TRANSITION" ||
    !settings.telegramChatId ||
    !process.env.TELEGRAM_BOT_TOKEN?.trim()
  )
    return;
  if (origin === "THRESHOLD_CHANGE" && !operation) return;
  // Serialize baseline aggregation across independent location commits, after shop/location locks.
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${settings.shopDomain}, 0))::text`;
  const [clock] = await tx.$queryRaw<
    { now: Date }[]
  >`SELECT clock_timestamp() AS now`;
  let batch =
    origin === "BASELINE"
      ? await tx.notificationDigest.findFirst({
          where: {
            shopDomain: settings.shopDomain,
            origin,
            chatId: settings.telegramChatId,
            closedAt: null,
            status: "PENDING",
            availableAt: { gt: clock.now },
          },
          orderBy: { createdAt: "asc" },
        })
      : await tx.notificationDigest.findUnique({
          where: {
            shopDomain_batchKey: {
              shopDomain: settings.shopDomain,
              batchKey: operation!.key,
            },
          },
        });
  if (!batch) {
    const locations = await tx.monitoredLocation.findMany({
      where: {
        shopDomain: settings.shopDomain,
        isActive: true,
        deletedAt: null,
      },
      orderBy: { locationGid: "asc" },
      select: { locationGid: true, locationName: true, generation: true },
    });
    const availableAt = new Date(
      clock.now.getTime() + (origin === "BASELINE" ? 30000 : 0),
    );
    batch = await tx.notificationDigest.create({
      data: {
        shopDomain: settings.shopDomain,
        batchKey: operation?.key ?? `baseline:${randomUUID()}`,
        origin,
        chatId: settings.telegramChatId,
        oldThreshold: operation?.oldThreshold,
        newThreshold: settings.lowStockThreshold,
        locations: locations.map((location) => ({
          ...location,
          generation: location.generation.toString(),
        })),
        availableAt,
        nextAttemptAt: availableAt,
      },
    });
  }
  await tx.inventoryAlert.updateMany({
    where: {
      inventoryLevelId,
      status: "ACTIVE",
      origin,
      digestId: null,
      inventoryLevel: { shopDomain: settings.shopDomain },
    },
    data: { digestId: batch.id },
  });
}

export function claimDigest(shopDomain: string): Promise<DigestClaim | null> {
  return db.$transaction(async (tx) => {
    // Same lock order as inventory/settings; membership freezes before the claim becomes visible.
    await tx.$queryRaw`SELECT "shopDomain" FROM "ShopSettings" WHERE "shopDomain"=${shopDomain} FOR UPDATE`;
    await tx.$executeRaw`UPDATE "NotificationDigest" SET "status"='FAILED', "nextAttemptAt"=NULL,
      "leaseUntil"=NULL,"leaseToken"=NULL,"error"='Digest retry limit reached.'
      WHERE "shopDomain"=${shopDomain} AND "status" IN ('PENDING','FAILED') AND "attempts">=${MAX_NOTIFICATION_ATTEMPTS}
      AND "nextAttemptAt" IS NOT NULL AND ("leaseUntil" IS NULL OR "leaseUntil"<=NOW())`;
    const [claim] = await tx.$queryRaw<DigestClaim[]>`
      WITH candidate AS (SELECT id FROM "NotificationDigest" WHERE "shopDomain"=${shopDomain}
        AND "status" IN ('PENDING','FAILED') AND "nextAttemptAt"<=NOW() AND "availableAt"<=NOW()
        AND "attempts"<${MAX_NOTIFICATION_ATTEMPTS} AND ("leaseUntil" IS NULL OR "leaseUntil"<=NOW())
        ORDER BY "nextAttemptAt", "createdAt", id LIMIT 1 FOR UPDATE SKIP LOCKED)
      UPDATE "NotificationDigest" d SET "attempts"=d."attempts"+1,"leaseToken"=${randomUUID()},
        "leaseUntil"=NOW()+INTERVAL '30 seconds',"closedAt"=COALESCE(d."closedAt",NOW()),"status"='PENDING'
      FROM candidate c WHERE d.id=c.id RETURNING d.*`;
    if (claim?.origin === "BASELINE" && claim.attempts === 1) {
      const expected = Array.isArray(claim.locations) ? claim.locations : [];
      const locations = await tx.monitoredLocation.findMany({
        where: { shopDomain, isActive: true, deletedAt: null },
        select: { locationGid: true, locationName: true, generation: true },
        orderBy: { locationGid: "asc" },
      });
      const added = locations.filter(
        (location) =>
          !expected.some(
            (v) =>
              v &&
              typeof v === "object" &&
              !Array.isArray(v) &&
              v.locationGid === location.locationGid,
          ),
      );
      if (added.length) {
        claim.locations = [
          ...expected,
          ...added.map((location) => ({
            ...location,
            generation: location.generation.toString(),
          })),
        ];
        await tx.notificationDigest.update({
          where: { id: claim.id },
          data: { locations: claim.locations },
        });
      }
    }
    return claim ?? null;
  });
}

export async function readDigest(claim: DigestClaim) {
  const settings = await db.shopSettings.findFirst({
    where: { shopDomain: claim.shopDomain, telegramChatId: claim.chatId },
    select: { shopDomain: true },
  });
  if (
    !settings ||
    !(await db.session.findFirst({
      where: { shop: claim.shopDomain, isOnline: false },
      select: { id: true },
    }))
  )
    return null;
  const lease = await db.$queryRaw<
    { id: string }[]
  >`SELECT id FROM "NotificationDigest" WHERE id=${claim.id}
    AND "shopDomain"=${claim.shopDomain} AND "leaseToken"=${claim.leaseToken} AND "leaseUntil">NOW()`;
  if (!lease.length) return null;
  const locations = await db.monitoredLocation.findMany({
    where: { shopDomain: claim.shopDomain },
  });
  const ready = locations.filter(
    (location) =>
      location.isActive &&
      !location.deletedAt &&
      location.baselineCompletedAt &&
      location.baselineAlertsCompletedAt,
  );
  const alerts = await db.inventoryAlert.findMany({
    where: {
      digestId: claim.id,
      origin: claim.origin,
      status: "ACTIVE",
      inventoryLevel: {
        shopDomain: claim.shopDomain,
        locationGid: { in: ready.map((location) => location.locationGid) },
        isCurrent: true,
        isLowStock: true,
      },
    },
    include: { inventoryLevel: true },
    orderBy: [
      { inventoryLevel: { locationGid: "asc" } },
      { inventoryLevel: { inventoryItemGid: "asc" } },
      { id: "asc" },
    ],
  });
  return { locations, alerts };
}

export async function finishDigest(
  claim: DigestClaim,
  input: {
    text?: string;
    alertIds?: string[];
    cancelled?: boolean;
    failure?: { message: string; retryable: boolean; retryAfterMs: number };
  },
) {
  const retry =
    !!input.failure?.retryable && claim.attempts < MAX_NOTIFICATION_ATTEMPTS;
  const delay = Math.max(
    claim.attempts === 1 ? 5000 : 30000,
    input.failure?.retryAfterMs ?? 0,
  );
  return db.$transaction(async (tx) => {
    const count = await tx.$executeRaw`UPDATE "NotificationDigest" SET
      "status"=CAST(${input.cancelled ? "CANCELLED" : input.failure ? "FAILED" : "SENT"} AS "DigestStatus"),
      "notifiedAt"=CASE WHEN ${!input.cancelled && !input.failure} THEN NOW() ELSE "notifiedAt" END,
      "text"=${input.text ?? null},"error"=${input.failure?.message ?? (input.cancelled ? "No eligible current alerts or destination changed." : null)},
      "nextAttemptAt"=CASE WHEN ${retry} THEN NOW()+${delay}*INTERVAL '1 millisecond' ELSE NULL END,
      "leaseUntil"=NULL,"leaseToken"=NULL
      WHERE id=${claim.id} AND "shopDomain"=${claim.shopDomain} AND "leaseToken"=${claim.leaseToken} AND "leaseUntil">NOW()`;
    if (count === 1 && !input.cancelled && !input.failure) {
      const [clock] = await tx.$queryRaw<
        { now: Date }[]
      >`SELECT NOW()::timestamptz(3) AS now`;
      await tx.inventoryAlert.updateMany({
        where: {
          digestId: claim.id,
          id: { in: input.alertIds ?? [] },
          inventoryLevel: { shopDomain: claim.shopDomain },
        },
        data: { notificationStatus: "SENT", notifiedAt: clock.now },
      });
    }
    return count;
  });
}
