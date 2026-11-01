import { Prisma } from "@prisma/client";
import db from "../../db.server";

import { PAGE_SIZE, type DashboardFilters } from "./filters";

export function getCoverage(shopDomain: string) {
  return db.monitoredLocation.findMany({
    where: { shopDomain },
    orderBy: [{ locationName: "asc" }, { locationGid: "asc" }],
    select: {
      locationGid: true,
      locationName: true,
      isActive: true,
      deletedAt: true,
      baselineCompletedAt: true,
      baselineAlertsCompletedAt: true,
      lastSyncedAt: true,
      lastSyncAttemptAt: true,
      lastSyncError: true,
    },
  });
}

export async function getDashboard(
  shopDomain: string,
  filters: DashboardFilters,
) {
  return db.$transaction(
    async (tx) => {
      const scope = Prisma.sql`i."shopDomain"=${shopDomain} AND (${filters.location}='all' OR i."locationGid"=${filters.location})
      AND i."isCurrent" AND EXISTS (SELECT 1 FROM "MonitoredLocation" l WHERE l."shopDomain"=i."shopDomain"
        AND l."locationGid"=i."locationGid" AND l."isActive" AND l."deletedAt" IS NULL
        AND l."baselineCompletedAt" IS NOT NULL AND l."baselineAlertsCompletedAt" IS NOT NULL AND l."syncStatus"='READY')`;
      const where = Prisma.sql`${scope}
      AND (${filters.stock}='all' OR (${filters.stock}='low' AND i."isLowStock") OR (${filters.stock}='normal' AND NOT i."isLowStock"))
      AND strpos(lower(concat_ws(' ',i.sku,
        (SELECT string_agg(concat_ws(' ',v->>'productTitle',v->>'variantTitle'),' ')
          FROM jsonb_array_elements(CASE WHEN jsonb_typeof(i.variants)='array' THEN i.variants ELSE '[]'::jsonb END) v),
        l."locationName",i."inventoryItemGid")),lower(${filters.query}))>0`;
      const from = Prisma.sql`FROM "InventoryLevel" i JOIN "MonitoredLocation" l ON l."shopDomain"=i."shopDomain" AND l."locationGid"=i."locationGid"`;
      const [counts] = await tx.$queryRaw<
        { items: number; low: number; active: number; products: number }[]
      >`
      SELECT count(*)::int AS items, count(*) FILTER(WHERE i."isLowStock")::int AS low,
        count(*) FILTER(WHERE EXISTS(SELECT 1 FROM "InventoryAlert" a WHERE a."inventoryLevelId"=i.id AND a.status='ACTIVE'))::int AS active,
        (SELECT count(DISTINCT v->>'productGid')::int FROM "InventoryLevel" i
          CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(i.variants)='array' THEN i.variants ELSE '[]'::jsonb END) v
          WHERE ${scope}) AS products
      FROM "InventoryLevel" i WHERE ${scope}`;
      const [total] = await tx.$queryRaw<
        { count: number }[]
      >`SELECT count(*)::int AS count ${from} WHERE ${where}`;
      const page = Math.min(
        filters.page,
        Math.max(1, Math.ceil(total.count / PAGE_SIZE)),
      );
      const rows = await tx.$queryRaw<
        {
          id: string;
          inventoryItemGid: string;
          locationGid: string;
          locationName: string | null;
          variants: Prisma.JsonValue;
          sku: string | null;
          availableQuantity: number;
          isLowStock: boolean;
          active: boolean;
        }[]
      >`SELECT i.id,i."inventoryItemGid",i."locationGid",l."locationName",i.variants,i.sku,i."availableQuantity",i."isLowStock",
        EXISTS(SELECT 1 FROM "InventoryAlert" a WHERE a."inventoryLevelId"=i.id AND a.status='ACTIVE') AS active
      ${from} WHERE ${where} ORDER BY l."locationName" NULLS LAST,i."locationGid",i."inventoryItemGid",i.id LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`;
      const coverage = await tx.monitoredLocation.findMany({
        where: { shopDomain },
        orderBy: [{ locationName: "asc" }, { locationGid: "asc" }],
        select: {
          locationGid: true,
          locationName: true,
          isActive: true,
          deletedAt: true,
          baselineCompletedAt: true,
          baselineAlertsCompletedAt: true,
          lastSyncedAt: true,
          lastSyncAttemptAt: true,
          lastSyncError: true,
        },
      });
      const locationCounts = await tx.$queryRaw<
        { locationGid: string; items: number; low: number }[]
      >`
      SELECT i."locationGid",count(*)::int AS items,count(*) FILTER(WHERE i."isLowStock")::int AS low FROM "InventoryLevel" i
      WHERE i."shopDomain"=${shopDomain} AND i."isCurrent" AND EXISTS (SELECT 1 FROM "MonitoredLocation" l
        WHERE l."shopDomain"=i."shopDomain" AND l."locationGid"=i."locationGid" AND l."isActive"
        AND l."deletedAt" IS NULL AND l."baselineCompletedAt" IS NOT NULL AND l."baselineAlertsCompletedAt" IS NOT NULL AND l."syncStatus"='READY') GROUP BY i."locationGid"`;
      const settings = await tx.shopSettings.findUnique({
        where: { shopDomain },
        select: { lowStockThreshold: true, telegramChatId: true },
      });
      const recent = await tx.inventoryAlert.findMany({
        where: {
          inventoryLevel: {
            shopDomain,
            ...(filters.location !== "all"
              ? { locationGid: filters.location }
              : {}),
          },
        },
        orderBy: [{ triggeredAt: "desc" }, { id: "desc" }],
        take: 4,
        include: { inventoryLevel: true, digest: true },
      });
      return {
        counts,
        rows,
        total: total.count,
        page,
        coverage,
        locationCounts,
        settings,
        recent,
      };
    },
    { isolationLevel: "RepeatableRead" },
  );
}

export function getAlertHistory(shopDomain: string, filters: DashboardFilters) {
  return db.$transaction(
    async (tx) => {
      const where: Prisma.InventoryAlertWhereInput = {
        inventoryLevel: {
          shopDomain,
          ...(filters.location !== "all"
            ? { locationGid: filters.location }
            : {}),
        },
        ...(filters.status !== "all"
          ? { status: filters.status as "ACTIVE" | "RESOLVED" }
          : {}),
        ...(filters.origin !== "all"
          ? {
              origin: filters.origin as
                "BASELINE" | "THRESHOLD_CHANGE" | "INVENTORY_TRANSITION",
            }
          : {}),
      };
      const total = await tx.inventoryAlert.count({ where });
      const page = Math.min(
        filters.page,
        Math.max(1, Math.ceil(total / PAGE_SIZE)),
      );
      const rows = await tx.inventoryAlert.findMany({
        where,
        include: { inventoryLevel: true, digest: true },
        orderBy: [{ triggeredAt: "desc" }, { id: "desc" }],
        take: PAGE_SIZE,
        skip: (page - 1) * PAGE_SIZE,
      });
      return { rows, page, total };
    },
    { isolationLevel: "RepeatableRead" },
  );
}
