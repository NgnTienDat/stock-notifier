import type { AdminContext } from "@shopify/shopify-app-react-router/server";
import { createShopifyGraphqlService } from "../shopify/graphql/shopify-graphql.server";
import {
  commitInventorySync,
  getInventorySyncSettings,
  InventorySyncError,
} from "./inventory.repository.server";

export { InventorySyncError } from "./inventory.repository.server";

export async function syncInventory(
  context: Pick<AdminContext, "admin" | "session">,
) {
  const startedAt = new Date();
  const settings = await getInventorySyncSettings(context.session.shop);
  if (!settings?.locationGid) {
    throw new InventorySyncError(
      "Select and save an inventory location before syncing.",
      400,
    );
  }
  const locationGid = settings.locationGid;
  // No inventory writes or open database transaction while reading Shopify pages.
  const levels =
    await createShopifyGraphqlService(context).getInventoryLevels(locationGid);
  return commitInventorySync({ ...settings, locationGid }, levels, startedAt);
}
