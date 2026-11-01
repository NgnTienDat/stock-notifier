import db from "../../db.server";
import { unauthenticated } from "../../shopify.server";
import { syncAllActiveLocations } from "./inventory-sync.service.server";
import { setTimeout as delay } from "node:timers/promises";
import { processNextWebhook } from "./webhook-job.service.server";
import { workerMilliseconds } from "./webhook-job.repository.server";

export async function syncInstalledShops(stopping = () => false) {
  let failed = false;
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
      if (result.failedCount) failed = true;
      console.info("Inventory background reconciliation", {
        shop,
        locations: result.locations.length,
        failed: result.failedCount,
      });
    } catch {
      failed = true;
      // SDK errors can contain credentials; log only the scope and recovery instruction.
      console.error(
        "Inventory reconciliation failed; retry on next pass, reopen app if auth expired.",
        { shop },
      );
    }
  }
  return failed;
}

export async function runInventoryWorker(signal: AbortSignal) {
  const interval = workerMilliseconds("INVENTORY_RECONCILE_INTERVAL_MS", 60000);
  const backoff = workerMilliseconds("INVENTORY_RETRY_BACKOFF_MS", 60000);
  const wait = (ms: number) =>
    delay(ms, undefined, { signal }).catch((error) => {
      if (!signal.aborted) throw error;
    });
  async function jobs() {
    while (!signal.aborted) {
      try {
        if (!(await processNextWebhook())) await wait(1000);
      } catch {
        console.error("Webhook queue unavailable; retrying.");
        await wait(workerMilliseconds("WEBHOOK_RETRY_BASE_MS", 5000));
      }
    }
  }
  async function reconcile() {
    while (!signal.aborted) {
      try {
        const failed = await syncInstalledShops(() => signal.aborted);
        await wait(failed ? Math.max(interval, backoff) : interval);
      } catch {
        console.error("Location reconciliation unavailable; retrying.");
        await wait(backoff);
      }
    }
  }
  // Both loops are awaited; jobs and progress are durable in PostgreSQL across restarts.
  await Promise.all([jobs(), reconcile()]);
}
