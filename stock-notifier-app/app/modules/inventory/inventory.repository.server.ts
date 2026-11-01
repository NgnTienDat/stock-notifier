import type { ShopSettings } from "@prisma/client";
import db from "../../db.server";
import type { InventoryLevelData } from "../shopify/graphql/types";

export class InventorySyncError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 409 = 409,
  ) {
    super(message);
    this.name = "InventorySyncError";
  }
}

export function getInventorySyncSettings(shopDomain: string) {
  return db.shopSettings.findUnique({
    where: { shopDomain },
    select: {
      shopDomain: true,
      locationGid: true,
      lowStockThreshold: true,
      lastSyncedAt: true,
      updatedAt: true,
    },
  });
}

type SyncSettings = NonNullable<
  Awaited<ReturnType<typeof getInventorySyncSettings>>
> & { locationGid: string };

export function commitInventorySync(
  settings: SyncSettings,
  levels: InventoryLevelData[],
  startedAt: Date,
) {
  return db.$transaction(
    async (tx) => {
      const [current] = await tx.$queryRaw<
        Pick<ShopSettings, "locationGid" | "updatedAt">[]
      >`
      SELECT "locationGid", "updatedAt" FROM "ShopSettings"
      WHERE "shopDomain" = ${settings.shopDomain} FOR UPDATE
    `;
      if (
        !current ||
        current.locationGid !== settings.locationGid ||
        current.updatedAt.getTime() !== settings.updatedAt.getTime()
      ) {
        throw new InventorySyncError(
          "Settings changed or another sync completed during this scan. Run Sync now again.",
        );
      }

      const scope = {
        shopDomain: settings.shopDomain,
        locationGid: settings.locationGid,
      };
      const existing = await tx.inventoryLevel.findMany({ where: scope });
      const byItem = new Map(
        existing.map((level) => [level.inventoryItemGid, level]),
      );
      const itemIds = levels.map((level) => level.inventoryItemGid);
      const seen = new Set(itemIds);
      if (
        seen.size !== levels.length ||
        levels.some(
          (level) =>
            level.shopDomain !== scope.shopDomain ||
            level.locationGid !== scope.locationGid,
        )
      ) {
        throw new InventorySyncError(
          "Inventory scan returned duplicate items or a different shop/location.",
        );
      }
      if (
        levels.some((level) => {
          const saved = byItem.get(level.inventoryItemGid);
          return (
            saved?.shopifyUpdatedAt &&
            (!level.shopifyUpdatedAt ||
              saved.shopifyUpdatedAt > level.shopifyUpdatedAt)
          );
        }) ||
        existing.some(
          (level) =>
            !seen.has(level.inventoryItemGid) && level.syncedAt >= startedAt,
        )
      ) {
        throw new InventorySyncError(
          "Inventory changed during this scan. Run Sync now again.",
        );
      }

      const syncedAt = new Date();
      for (const level of levels) {
        const data = {
          variants: level.variants,
          sku: level.sku,
          availableQuantity: level.availableQuantity,
          isLowStock: level.availableQuantity <= settings.lowStockThreshold,
          isCurrent: true,
          shopifyUpdatedAt: level.shopifyUpdatedAt,
          syncedAt,
        };
        await tx.inventoryLevel.upsert({
          where: {
            shopDomain_locationGid_inventoryItemGid: {
              ...scope,
              inventoryItemGid: level.inventoryItemGid,
            },
          },
          create: {
            ...scope,
            inventoryItemGid: level.inventoryItemGid,
            ...data,
          },
          update: data,
        });
      }

      const missing = { ...scope, inventoryItemGid: { notIn: itemIds } };
      const stale = await tx.inventoryLevel.updateMany({
        where: { ...missing, isCurrent: true },
        data: { isCurrent: false },
      });
      await tx.inventoryAlert.updateMany({
        where: { status: "ACTIVE", inventoryLevel: missing },
        data: { status: "RESOLVED", resolvedAt: syncedAt },
      });
      await tx.shopSettings.update({
        where: { shopDomain: settings.shopDomain },
        data: {
          lastSyncedAt: syncedAt,
          updatedAt: new Date(
            Math.max(syncedAt.getTime(), current.updatedAt.getTime() + 1),
          ),
        },
      });
      return {
        itemCount: levels.length,
        staleCount: stale.count,
        baseline: settings.lastSyncedAt === null,
        syncedAt,
      };
    },
    { timeout: 15000 },
  );
}
