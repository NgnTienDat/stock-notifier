import type { ShopSettings } from "@prisma/client";
import db from "../../db.server";
import type { LocationData } from "../shopify/graphql/types";

const locationFields = { locationGid: true, locationName: true } as const;

export function getLocationSettings(shopDomain: string) {
  return db.shopSettings.findUnique({
    where: { shopDomain },
    select: {
      ...locationFields,
      lastSyncedAt: true,
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
      await tx.inventoryAlert.updateMany({
        where: { status: "ACTIVE", inventoryLevel: scope },
        data: { status: "RESOLVED", resolvedAt: new Date() },
      });
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
