import type { ShopSettings } from "@prisma/client";
import db from "../../db.server";
import type { LocationData } from "../shopify/graphql/types";
import { resolveActiveAlerts } from "../alerts/alert.service.server";

const locationFields = { locationGid: true, locationName: true } as const;

export function getLocationSettings(shopDomain: string) {
  return db.shopSettings.findUnique({
    where: { shopDomain },
    select: {
      ...locationFields,
      lastSyncedAt: true,
      lowStockThreshold: true,
      telegramChatId: true,
    },
  });
}

export function saveLocationSettings(
  shopDomain: string,
  location: LocationData,
) {
  return db.$transaction(async (tx) => {
    await tx.shopSettings.createMany({
      data: [{ shopDomain }],
      skipDuplicates: true,
    });
    // Serialize location changes for this shop, including the first selection.
    const [current] = await tx.$queryRaw<
      Pick<ShopSettings, "locationGid" | "updatedAt">[]
    >`
      SELECT "locationGid", "updatedAt" FROM "ShopSettings"
      WHERE "shopDomain" = ${shopDomain} FOR UPDATE
    `;

    const changed = current.locationGid !== location.locationGid;
    if (changed && current.locationGid) {
      const scope = { shopDomain, locationGid: current.locationGid };
      await resolveActiveAlerts(tx, scope, {}, new Date());
      await tx.inventoryLevel.updateMany({
        where: scope,
        data: { isCurrent: false },
      });
    }

    return tx.shopSettings.update({
      where: { shopDomain },
      data: {
        locationGid: location.locationGid,
        locationName: location.locationName,
        ...(changed ? { lastSyncedAt: null } : {}),
        // Invalidate scans even for A -> B -> A within the same millisecond.
        updatedAt: new Date(
          Math.max(Date.now(), current.updatedAt.getTime() + 1),
        ),
      },
      select: locationFields,
    });
  });
}

export function saveLowStockThreshold(
  shopDomain: string,
  lowStockThreshold: number,
) {
  return db.$transaction(async (tx) => {
    await tx.shopSettings.createMany({
      data: [{ shopDomain }],
      skipDuplicates: true,
    });
    const [current] = await tx.$queryRaw<
      Pick<
        ShopSettings,
        "locationGid" | "lastSyncedAt" | "lowStockThreshold" | "updatedAt"
      >[]
    >`
      SELECT "locationGid", "lastSyncedAt", "lowStockThreshold", "updatedAt"
      FROM "ShopSettings" WHERE "shopDomain" = ${shopDomain} FOR UPDATE
    `;
    if (current.lowStockThreshold === lowStockThreshold)
      return { lowStockThreshold };
    const now = new Date();
    if (current.locationGid) {
      const scope = { shopDomain, locationGid: current.locationGid };
      if (current.lastSyncedAt) {
        await tx.inventoryLevel.updateMany({
          where: {
            ...scope,
            isCurrent: true,
            availableQuantity: { lte: lowStockThreshold },
          },
          data: { isLowStock: true },
        });
        await tx.inventoryLevel.updateMany({
          where: {
            ...scope,
            isCurrent: true,
            availableQuantity: { gt: lowStockThreshold },
          },
          data: { isLowStock: false },
        });
      }
      await resolveActiveAlerts(
        tx,
        scope,
        current.lastSyncedAt
          ? { OR: [{ isCurrent: false }, { isLowStock: false }] }
          : {},
        now,
      );
    }
    return tx.shopSettings.update({
      where: { shopDomain },
      data: {
        lowStockThreshold,
        updatedAt: new Date(
          Math.max(now.getTime(), current.updatedAt.getTime() + 1),
        ),
      },
      select: { lowStockThreshold: true },
    });
  });
}

export function saveTelegramChatId(
  shopDomain: string,
  telegramChatId: string | null,
) {
  return db.$transaction(async (tx) => {
    await tx.shopSettings.createMany({
      data: [{ shopDomain }],
      skipDuplicates: true,
    });
    const [current] = await tx.$queryRaw<
      Pick<ShopSettings, "telegramChatId" | "updatedAt">[]
    >`
      SELECT "telegramChatId", "updatedAt" FROM "ShopSettings" WHERE "shopDomain" = ${shopDomain} FOR UPDATE
    `;
    if (current.telegramChatId === telegramChatId) return;
    await tx.shopSettings.update({
      where: { shopDomain },
      data: {
        telegramChatId,
        updatedAt: new Date(
          Math.max(Date.now(), current.updatedAt.getTime() + 1),
        ),
      },
    });
  });
}
