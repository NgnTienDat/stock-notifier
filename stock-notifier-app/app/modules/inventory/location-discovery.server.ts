import type { AdminContext } from "@shopify/shopify-app-react-router/server";
import db from "../../db.server";
import { createShopifyGraphqlService } from "../shopify/graphql/shopify-graphql.server";
import { applyLocationState } from "./location.repository.server";
import { InventorySyncError } from "./inventory.repository.server";
import {
  assertWebhookLease,
  type WebhookClaim,
} from "./webhook-job.repository.server";

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
      const accepted = new Set<string>();
      for (const location of locations) {
        const saved = await applyLocationState(
          tx,
          { shopDomain, locationGid: location.locationGid },
          { ...location, isActive: true },
          now,
        );
        if (saved.isActive && !saved.deletedAt) accepted.add(saved.locationGid);
      }
      const missing = await tx.monitoredLocation.findMany({
        where: {
          shopDomain,
          locationGid: { notIn: ids },
          OR: [
            { isActive: true },
            { isActive: null },
            { deletedAt: { not: null } },
          ],
        },
      });
      for (const location of missing)
        await applyLocationState(
          tx,
          { shopDomain, locationGid: location.locationGid },
          null,
          now,
          location.deletedAt !== null,
        );
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
      return locations.filter((location) => accepted.has(location.locationGid));
    },
    { timeout: 15000 },
  );
}

export async function refreshLocation(
  context: ShopifyContext,
  locationGid: string,
  job?: WebhookClaim,
) {
  const shopDomain = context.session.shop;
  const settings = await db.shopSettings.findUniqueOrThrow({
    where: { shopDomain },
  });
  const previous = await db.monitoredLocation.findUnique({
    where: { shopDomain_locationGid: { shopDomain, locationGid } },
  });
  const deleted = job?.topic === "LOCATIONS_DELETE";
  const metadata = deleted
    ? null
    : await createShopifyGraphqlService(context, {
        signal: AbortSignal.timeout(30000),
      }).getLocation(locationGid);
  return db.$transaction(
    async (tx) => {
      const [current] = await tx.$queryRaw<
        (typeof settings)[]
      >`SELECT * FROM "ShopSettings" WHERE "shopDomain"=${shopDomain} FOR UPDATE`;
      const location = await tx.monitoredLocation.findUnique({
        where: { shopDomain_locationGid: { shopDomain, locationGid } },
      });
      if (
        !current ||
        current.updatedAt.getTime() !== settings.updatedAt.getTime() ||
        location?.version !== previous?.version
      )
        throw new InventorySyncError(
          "Location/settings changed during metadata read; retry required",
        );
      if (job) await assertWebhookLease(tx, job);
      if (
        !(await tx.session.findFirst({
          where: { id: context.session.id, shop: shopDomain, isOnline: false },
          select: { id: true },
        }))
      )
        throw new Error("Offline session removed");
      const now = new Date();
      const saved = await applyLocationState(
        tx,
        { shopDomain, locationGid },
        metadata,
        now,
        deleted,
      );
      // Invalidate discovery results captured before this lifecycle change.
      if (saved.version !== previous?.version || !previous)
        await tx.shopSettings.update({
          where: { shopDomain },
          data: {
            updatedAt: new Date(
              Math.max(now.getTime(), current.updatedAt.getTime() + 1),
            ),
          },
        });
      return saved;
    },
    { timeout: 15000 },
  );
}
