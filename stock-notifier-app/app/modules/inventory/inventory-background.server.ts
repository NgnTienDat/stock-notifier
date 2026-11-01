import db from "../../db.server";
import { unauthenticated } from "../../shopify.server";
import { syncAllActiveLocations } from "./inventory-sync.service.server";

export async function syncInstalledShops(stopping = () => false) {
  const shops = await db.session.findMany({
    where: { isOnline: false },
    select: { shop: true },
    distinct: ["shop"],
    orderBy: { shop: "asc" },
  });
  for (const { shop } of shops) {
    if (stopping()) break;
    try {
      // Shop comes only from persisted authenticated sessions, never browser input.
      const context = await unauthenticated.admin(shop);
      if (context.session.shop !== shop || context.session.isOnline)
        throw new Error("Offline context does not match persisted shop");
      const result = await syncAllActiveLocations(context, true);
      console.info("Inventory background reconciliation", {
        shop,
        locations: result.locations.length,
        failed: result.failedCount,
      });
    } catch {
      // SDK errors can contain credentials; log only the scope and recovery instruction.
      console.error(
        "Inventory reconciliation failed; retry on next pass, reopen app if auth expired.",
        { shop },
      );
    }
  }
}
