import type { MonitoredLocation, ShopSettings } from "@prisma/client";
import { Prisma } from "@prisma/client";
import db from "../../db.server";
import type { InventoryLevelData } from "../shopify/graphql/types";
import {
  applyInventoryAlertTransition,
  resolveActiveAlerts,
} from "../alerts/alert.service.server";

export class InventorySyncError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 409 = 409,
  ) {
    super(message);
    this.name = "InventorySyncError";
  }
}

export async function getInventorySyncSettings(
  shopDomain: string,
  locationGid?: string,
) {
  const settings = await db.shopSettings.findUnique({
    where: { shopDomain },
    select: {
      shopDomain: true,
      locationGid: true,
      lowStockThreshold: true,
      telegramChatId: true,
      locationName: true,
      lastSyncedAt: true,
      updatedAt: true,
      locationsDiscoveredAt: true,
    },
  });
  if (!settings) return null;
  const monitored =
    settings.locationsDiscoveredAt && (locationGid ?? settings.locationGid)
      ? await db.monitoredLocation.findUnique({
          where: {
            shopDomain_locationGid: {
              shopDomain,
              locationGid: (locationGid ?? settings.locationGid)!,
            },
          },
        })
      : null;
  return {
    ...settings,
    ...(settings.locationsDiscoveredAt
      ? {
          locationGid: monitored?.isActive ? monitored.locationGid : null,
          locationName: monitored?.locationName ?? null,
          lastSyncedAt: monitored?.baselineCompletedAt ?? null,
        }
      : {}),
    monitored,
  };
}

type SyncSettings = NonNullable<
  Awaited<ReturnType<typeof getInventorySyncSettings>>
> & { locationGid: string };

export function commitInventorySync(
  settings: SyncSettings,
  levels: InventoryLevelData[],
  startedAt: Date,
  offlineSessionId?: string,
) {
  return db.$transaction(
    async (tx) => {
      const [current] = await tx.$queryRaw<
        Pick<ShopSettings, "locationGid" | "updatedAt">[]
      >`
      SELECT "locationGid", "updatedAt" FROM "ShopSettings"
      WHERE "shopDomain" = ${settings.shopDomain}
      ${settings.monitored ? Prisma.sql`FOR SHARE` : Prisma.sql`FOR UPDATE`}
    `;
      if (
        !current ||
        (!settings.monitored && current.locationGid !== settings.locationGid) ||
        current.updatedAt.getTime() !== settings.updatedAt.getTime()
      ) {
        throw new InventorySyncError(
          "Settings changed or another sync completed during this scan. Run Sync now again.",
        );
      }
      if (settings.monitored) {
        if (
          offlineSessionId &&
          !(await tx.session.findFirst({
            where: {
              id: offlineSessionId,
              shop: settings.shopDomain,
              isOnline: false,
            },
            select: { id: true },
          }))
        )
          throw new InventorySyncError("Offline session removed during scan.");
        const [location] = await tx.$queryRaw<MonitoredLocation[]>`
          SELECT * FROM "MonitoredLocation" WHERE "shopDomain" = ${settings.shopDomain}
          AND "locationGid" = ${settings.locationGid} FOR UPDATE
        `;
        if (
          !location?.isActive ||
          location.version !== settings.monitored.version
        )
          throw new InventorySyncError(
            "Location changed during scan. Retry sync.",
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
      let alertsCreated = 0;
      let alertsResolved = 0;
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
        const saved = await tx.inventoryLevel.upsert({
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
        const alerts = await applyInventoryAlertTransition(
          tx,
          settings,
          byItem.get(level.inventoryItemGid) ?? null,
          saved,
          syncedAt,
          settings.monitored &&
            (!settings.monitored.baselineAlertsCompletedAt ||
              !byItem.get(level.inventoryItemGid)?.isCurrent)
            ? "BASELINE"
            : "INVENTORY_TRANSITION",
        );
        alertsCreated += alerts.created;
        alertsResolved += alerts.resolved;
      }

      const missing = { ...scope, inventoryItemGid: { notIn: itemIds } };
      const stale = await tx.inventoryLevel.updateMany({
        where: { ...missing, isCurrent: true },
        data: { isCurrent: false },
      });
      alertsResolved += await resolveActiveAlerts(tx, scope, missing, syncedAt);
      if (settings.monitored) {
        await tx.monitoredLocation.update({
          where: { shopDomain_locationGid: scope },
          data: {
            lastSyncedAt: syncedAt,
            baselineCompletedAt:
              settings.monitored.baselineCompletedAt ?? syncedAt,
            baselineAlertsCompletedAt: syncedAt,
            syncStatus: "READY",
            version: { increment: 1 },
          },
        });
      } else
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
        alertsCreated,
        alertsResolved,
      };
    },
    { timeout: 15000 },
  );
}
