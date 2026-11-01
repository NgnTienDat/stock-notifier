import { unauthenticated } from "../../shopify.server";
import { createShopifyGraphqlService } from "../shopify/graphql/shopify-graphql.server";
import { getInventorySyncSettings } from "./inventory.repository.server";
import { commitInventoryWebhook } from "./inventory-webhook.repository.server";
import { refreshLocation } from "./location-discovery.server";
import { syncInventoryForLocation } from "./inventory-sync.service.server";
import {
  claimWebhookJob,
  finishIgnoredWebhook,
  retryWebhookJob,
  type WebhookClaim,
} from "./webhook-job.repository.server";

export async function processWebhookJob(job: WebhookClaim) {
  const context = await unauthenticated.admin(job.shopDomain);
  if (context.session.shop !== job.shopDomain || context.session.isOnline)
    throw new Error("Offline session scope mismatch");
  const locationGid = job.locationGid!;
  if (job.topic?.startsWith("LOCATIONS_")) {
    const location = await refreshLocation(context, locationGid, job);
    if (
      location.isActive &&
      !location.deletedAt &&
      (!location.baselineCompletedAt || !location.baselineAlertsCompletedAt)
    )
      await syncInventoryForLocation(context, locationGid);
    await finishIgnoredWebhook(
      job,
      location.deletedAt ? "location_deleted" : "location_reconciled",
    );
    return;
  }
  let settings = await getInventorySyncSettings(job.shopDomain, locationGid);
  if (!settings) throw new Error("Shop settings missing");
  if (!settings.monitored) {
    await refreshLocation(context, locationGid, job);
    settings = await getInventorySyncSettings(job.shopDomain, locationGid);
  }
  if (!settings?.monitored?.isActive || settings.monitored.deletedAt) {
    await finishIgnoredWebhook(job, "location_inactive");
    return;
  }
  if (
    job.generation !== null &&
    job.generation !== settings.monitored.generation
  ) {
    await finishIgnoredWebhook(job, "stale_cycle");
    return;
  }
  if (
    !settings.monitored.baselineCompletedAt ||
    !settings.monitored.baselineAlertsCompletedAt
  ) {
    await syncInventoryForLocation(context, locationGid);
    settings = await getInventorySyncSettings(job.shopDomain, locationGid);
    if (!settings?.monitored?.isActive)
      throw new Error("Location changed after baseline");
  }
  const level = await createShopifyGraphqlService(context, {
    signal: AbortSignal.timeout(60000),
  }).getInventoryLevel(locationGid, job.inventoryItemGid!);
  await commitInventoryWebhook(
    settings,
    context.session.id,
    job.webhookId,
    locationGid,
    job.inventoryItemGid!,
    level,
    job,
  );
}

export async function processNextWebhook(shopDomain?: string) {
  const job = await claimWebhookJob(shopDomain);
  if (!job) return false;
  try {
    await processWebhookJob(job);
  } catch {
    await retryWebhookJob(job);
    console.error("Webhook processing deferred", {
      shop: job.shopDomain,
      webhookId: job.webhookId,
      attempt: job.attempts,
    });
  }
  return true;
}
