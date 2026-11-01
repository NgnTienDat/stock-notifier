import type {
  InventoryLevel,
  MonitoredLocation,
  ShopSettings,
} from "@prisma/client";
import db from "../../db.server";
import {
  completeWebhookJob,
  type WebhookClaim,
} from "./webhook-job.repository.server";
import { applyInventoryAlertTransition } from "../alerts/alert.service.server";
import type { InventoryLevelData } from "../shopify/graphql/types";
import type { getInventorySyncSettings } from "./inventory.repository.server";

type Settings = NonNullable<
  Awaited<ReturnType<typeof getInventorySyncSettings>>
>;

export function commitInventoryWebhook(
  settings: Settings,
  sessionId: string,
  webhookId: string,
  locationGid: string,
  inventoryItemGid: string,
  level: InventoryLevelData | null | undefined,
  job?: WebhookClaim,
) {
  return db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SET LOCAL lock_timeout = '500ms'`;
      await tx.$executeRaw`SET LOCAL statement_timeout = '1000ms'`;
      const [current] = await tx.$queryRaw<ShopSettings[]>`
      SELECT * FROM "ShopSettings" WHERE "shopDomain" = ${settings.shopDomain} FOR SHARE
    `;
      if (!current || !settings.monitored)
        throw new Error("Monitored settings missing; retry required");
      if (
        await tx.webhookEvent.findUnique({
          where: {
            processedAt: { not: null },
            shopDomain_webhookId: {
              shopDomain: settings.shopDomain,
              webhookId,
            },
          },
        })
      )
        return "duplicate";
      if (
        !(await tx.session.findFirst({
          where: { id: sessionId, shop: settings.shopDomain, isOnline: false },
          select: { id: true },
        }))
      ) {
        throw new Error("Offline session missing; retry required");
      }
      if (settings.monitored) {
        const [location] = await tx.$queryRaw<MonitoredLocation[]>`
          SELECT * FROM "MonitoredLocation" WHERE "shopDomain" = ${settings.shopDomain}
          AND "locationGid" = ${settings.monitored.locationGid} FOR UPDATE
        `;
        if (
          !location?.isActive ||
          location.version !== settings.monitored.version
        )
          throw new Error(
            "Location changed during webhook read; retry required",
          );
      }
      if (current.updatedAt.getTime() !== settings.updatedAt.getTime()) {
        throw new Error(
          "Inventory/settings changed during webhook read; retry required",
        );
      }
      let result = "location_ignored";
      if (locationGid === settings.monitored.locationGid) {
        if (level === undefined)
          throw new Error("Missing Shopify inventory read");
        const scope = {
          shopDomain: settings.shopDomain,
          locationGid,
          inventoryItemGid,
        };
        if (
          level &&
          (level.shopDomain !== scope.shopDomain ||
            level.locationGid !== locationGid ||
            level.inventoryItemGid !== inventoryItemGid)
        ) {
          throw new Error("Inventory does not belong to webhook scope");
        }
        const previous = await tx.inventoryLevel.findUnique({
          where: { shopDomain_locationGid_inventoryItemGid: scope },
        });
        if (
          level?.shopifyUpdatedAt &&
          previous?.shopifyUpdatedAt &&
          level.shopifyUpdatedAt < previous.shopifyUpdatedAt
        ) {
          result = "stale_read";
        } else {
          const now = new Date();
          let saved: InventoryLevel | null = null;
          if (level) {
            const data = {
              variants: level.variants,
              sku: level.sku,
              availableQuantity: level.availableQuantity,
              isLowStock: level.availableQuantity <= current.lowStockThreshold,
              isCurrent: true,
              shopifyUpdatedAt: level.shopifyUpdatedAt,
              syncedAt: now,
            };
            saved = await tx.inventoryLevel.upsert({
              where: { shopDomain_locationGid_inventoryItemGid: scope },
              create: { ...scope, ...data },
              update: data,
            });
          } else if (previous) {
            saved = await tx.inventoryLevel.update({
              where: { shopDomain_locationGid_inventoryItemGid: scope },
              data: { isCurrent: false, syncedAt: now },
            });
          }
          if (saved)
            await applyInventoryAlertTransition(
              tx,
              settings,
              previous,
              saved,
              now,
              previous?.isCurrent ? "INVENTORY_TRANSITION" : "BASELINE",
            );
          // Invalidate in-flight full scans and other webhook reads, including negative reads.
          if (settings.monitored)
            await tx.monitoredLocation.update({
              where: {
                shopDomain_locationGid: {
                  shopDomain: settings.shopDomain,
                  locationGid,
                },
              },
              data: { version: { increment: 1 } },
            });
          result = level ? "updated" : "invalidated";
        }
      }
      if (job) await completeWebhookJob(tx, job, result);
      else
        await tx.webhookEvent.create({
          data: {
            shopDomain: settings.shopDomain,
            webhookId,
            processedAt: new Date(),
          },
        });
      return result;
    },
    { maxWait: 500, timeout: 1500 },
  );
}

export function deleteUninstalledSessions(shop: string) {
  return db.$transaction(async (tx) => {
    // Serialize uninstall with inventory commits that recheck the offline session.
    await tx.$queryRaw`SELECT "shopDomain" FROM "ShopSettings" WHERE "shopDomain" = ${shop} FOR UPDATE`;
    await tx.session.deleteMany({ where: { shop } });
  });
}
