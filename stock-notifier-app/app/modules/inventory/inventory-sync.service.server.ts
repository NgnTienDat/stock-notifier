import type { AdminContext } from "@shopify/shopify-app-react-router/server";
import { createShopifyGraphqlService } from "../shopify/graphql/shopify-graphql.server";
import { discoverLocations } from "./location-discovery.server";
import {
  commitInventorySync,
  getInventorySyncSettings,
  InventorySyncError,
} from "./inventory.repository.server";

export { InventorySyncError } from "./inventory.repository.server";

export async function syncInventory(
  context: Pick<AdminContext, "admin" | "session">,
  retryLocationGid?: string,
) {
  if (retryLocationGid) {
    const result = await syncInventoryForLocation(context, retryLocationGid);
    return {
      ...result,
      failedCount: 0,
      locations: [{ ...result, locationGid: retryLocationGid, error: null }],
    };
  }
  return syncAllActiveLocations(context);
}

export async function syncInventoryForLocation(
  context: Pick<AdminContext, "admin" | "session">,
  requestedLocation: string,
) {
  const startedAt = new Date();
  const settings = await getInventorySyncSettings(
    context.session.shop,
    requestedLocation,
  );
  if (!settings?.monitored?.isActive || !settings.locationGid) {
    throw new InventorySyncError(
      "Location is not verified active. Run discovery before syncing.",
      400,
    );
  }
  const locationGid = settings.locationGid;
  // No inventory writes or open database transaction while reading Shopify pages.
  const levels = await createShopifyGraphqlService(context, {
    signal: AbortSignal.timeout(60000),
    requireAvailable: true,
  }).getInventoryLevels(locationGid);
  // Verify active again after the complete scan, including an empty scan.
  if (
    !(
      await createShopifyGraphqlService(context, {
        signal: AbortSignal.timeout(60000),
      }).getLocations()
    ).some((location) => location.locationGid === locationGid)
  )
    throw new InventorySyncError(
      "Location no longer active after scan; retry discovery.",
    );
  return commitInventorySync(
    { ...settings, locationGid },
    levels,
    startedAt,
    context.session.isOnline ? undefined : context.session.id,
  );
}

export async function syncAllActiveLocations(
  context: Pick<AdminContext, "admin" | "session">,
  onlyDue = false,
) {
  const locations = await discoverLocations(context);
  const results: {
    locationGid: string;
    error: string | null;
    itemCount: number;
    staleCount: number;
    alertsCreated: number;
    alertsResolved: number;
    baseline: boolean;
  }[] = [];
  // shortcut: concurrency is 1 per worker, duplicate workers may reread; add scan leases if API load warrants it.
  for (const location of locations) {
    const settings = await getInventorySyncSettings(
      context.session.shop,
      location.locationGid,
    );
    if (
      onlyDue &&
      settings?.monitored?.baselineAlertsCompletedAt &&
      settings.monitored.lastSyncedAt &&
      Date.now() - settings.monitored.lastSyncedAt.getTime() <
        Number(process.env.INVENTORY_RECONCILE_INTERVAL_MS ?? 60000)
    )
      continue;
    try {
      let result;
      for (let attempt = 0; ; attempt++) {
        try {
          result = await syncInventoryForLocation(
            context,
            location.locationGid,
          );
          break;
        } catch (error) {
          if (
            !(error instanceof InventorySyncError) ||
            error.status !== 409 ||
            attempt >= 1
          )
            throw error;
        }
      }
      results.push({
        locationGid: location.locationGid,
        error: null,
        ...result,
      });
    } catch (error) {
      if (
        error instanceof Response &&
        (error.status === 401 || (error.status >= 300 && error.status < 400))
      )
        throw error;
      results.push({
        locationGid: location.locationGid,
        error: "Sync failed; previous data was kept. Retry this location.",
        itemCount: 0,
        staleCount: 0,
        alertsCreated: 0,
        alertsResolved: 0,
        baseline: false,
      });
    }
  }
  return {
    locations: results,
    failedCount: results.filter((result) => result.error).length,
    itemCount: results.reduce((sum, result) => sum + result.itemCount, 0),
    staleCount: results.reduce((sum, result) => sum + result.staleCount, 0),
    alertsCreated: results.reduce(
      (sum, result) => sum + result.alertsCreated,
      0,
    ),
    alertsResolved: results.reduce(
      (sum, result) => sum + result.alertsResolved,
      0,
    ),
    baseline: results.some((result) => result.baseline),
  };
}
