import type { AdminContext } from "@shopify/shopify-app-react-router/server";
import db from "../../db.server";
import { createShopifyGraphqlService } from "../shopify/graphql/shopify-graphql.server";
import { resolveActiveAlerts } from "../alerts/alert.service.server";
import { InventorySyncError } from "./inventory.repository.server";

export type ShopifyContext = Pick<AdminContext, "admin" | "session">;

export async function discoverLocations(context: ShopifyContext) {
  const shopDomain = context.session.shop;
  const settings = await db.shopSettings.upsert({
    where: { shopDomain },
    create: { shopDomain },
    update: {},
  });
  // getLocations verifies isActive and exhausts pagination before any location write.
  const locations = await createShopifyGraphqlService(context, {
    signal: AbortSignal.timeout(60000),
  }).getLocations();
  const ids = locations.map((location) => location.locationGid);
  if (new Set(ids).size !== ids.length)
    throw new InventorySyncError("Duplicate location in discovery; retry.");
  return db.$transaction(
    async (tx) => {
      const [current] = await tx.$queryRaw<(typeof settings)[]>`
      SELECT * FROM "ShopSettings" WHERE "shopDomain" = ${shopDomain} FOR UPDATE
    `;
      if (
        !current ||
        current.updatedAt.getTime() !== settings.updatedAt.getTime() ||
        current.locationsDiscoveredAt?.getTime() !==
          settings.locationsDiscoveredAt?.getTime()
      )
        throw new InventorySyncError(
          "Settings/discovery changed; retry discovery.",
        );
      if (
        context.session.isOnline === false &&
        !(await tx.session.findFirst({
          where: { id: context.session.id, shop: shopDomain, isOnline: false },
          select: { id: true },
        }))
      )
        throw new InventorySyncError(
          "Offline session removed; reopen the app.",
        );
      const now = new Date();
      for (const location of locations) {
        const where = {
          shopDomain_locationGid: {
            shopDomain,
            locationGid: location.locationGid,
          },
        };
        const previous = await tx.monitoredLocation.findUnique({ where });
        if (!previous)
          await tx.monitoredLocation.create({
            data: { shopDomain, ...location, isActive: true },
          });
        else if (
          previous.isActive !== true ||
          previous.locationName !== location.locationName
        )
          await tx.monitoredLocation.update({
            where,
            data: { ...location, isActive: true, version: { increment: 1 } },
          });
      }
      const missing = await tx.monitoredLocation.findMany({
        where: {
          shopDomain,
          locationGid: { notIn: ids },
          OR: [{ isActive: true }, { isActive: null }],
        },
      });
      for (const location of missing) {
        const scope = { shopDomain, locationGid: location.locationGid };
        await tx.monitoredLocation.update({
          where: { shopDomain_locationGid: scope },
          data: { isActive: false, version: { increment: 1 } },
        });
        await tx.inventoryLevel.updateMany({
          where: scope,
          data: { isCurrent: false },
        });
        await resolveActiveAlerts(tx, scope, {}, now);
      }
      await tx.shopSettings.update({
        where: { shopDomain },
        data: {
          locationsDiscoveredAt: new Date(
            Math.max(
              now.getTime(),
              (current.locationsDiscoveredAt?.getTime() ?? 0) + 1,
            ),
          ),
          updatedAt: current.locationsDiscoveredAt
            ? current.updatedAt
            : new Date(
                Math.max(now.getTime(), current.updatedAt.getTime() + 1),
              ),
        },
      });
      return locations;
    },
    { timeout: 15000 },
  );
}
