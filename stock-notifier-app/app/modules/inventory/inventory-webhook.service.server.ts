import type { authenticate } from "../../shopify.server";
import { createShopifyGraphqlService } from "../shopify/graphql/shopify-graphql.server";
import { getInventorySyncSettings } from "./inventory.repository.server";
import {
  commitInventoryWebhook,
  hasInventoryWebhook,
} from "./inventory-webhook.repository.server";

export class InvalidInventoryWebhookError extends Error {}

export function decodeInventoryWebhookBody(
  rawBody: string,
): Record<string, unknown> {
  // Node 22 JSON source preserves Shopify's 64-bit numeric IDs before Number rounds them.
  const payload = JSON.parse(
    rawBody,
    (key: string, value: unknown, source?: { source: string }) =>
      (key === "inventory_item_id" || key === "location_id") &&
      typeof value === "number"
        ? (source?.source ?? value)
        : value,
  );
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    throw new InvalidInventoryWebhookError("Invalid inventory payload");
  return payload;
}
const topics = new Set([
  "INVENTORY_LEVELS_UPDATE",
  "INVENTORY_LEVELS_CONNECT",
  "INVENTORY_LEVELS_DISCONNECT",
]);

function resourceGid(resource: string, value: unknown) {
  const id =
    typeof value === "string"
      ? value
      : typeof value === "number" && Number.isSafeInteger(value)
        ? String(value)
        : "";
  if (!/^[1-9]\d*$/.test(id))
    throw new InvalidInventoryWebhookError(`Invalid ${resource} ID`);
  return `gid://shopify/${resource}/${id}`;
}

export function parseInventoryWebhook(
  topic: string,
  payload: Record<string, unknown>,
  webhookId: string,
) {
  if (!topics.has(topic) || !webhookId?.trim())
    throw new InvalidInventoryWebhookError(
      "Invalid inventory webhook topic or delivery ID",
    );
  return {
    locationGid: resourceGid("Location", payload.location_id),
    inventoryItemGid: resourceGid("InventoryItem", payload.inventory_item_id),
  };
}

export async function processInventoryWebhook(
  context: Awaited<ReturnType<typeof authenticate.webhook>>,
) {
  const { shop, session, admin, topic, webhookId, payload } = context;
  const { locationGid, inventoryItemGid } = parseInventoryWebhook(
    topic,
    payload,
    webhookId,
  );
  if (!session || !admin) return "session_missing";
  if (session.shop !== shop || session.isOnline)
    throw new InvalidInventoryWebhookError("Invalid webhook session shop");
  const settings = await getInventorySyncSettings(shop);
  if (!settings?.locationGid) return "settings_missing";
  if (await hasInventoryWebhook(shop, webhookId)) return "duplicate";
  // One current item read, no in-request backoff; Shopify retries failed deliveries.
  const level =
    locationGid === settings.locationGid
      ? await createShopifyGraphqlService(
          { admin, session },
          { signal: AbortSignal.timeout(2500), maxRetries: 0 },
        ).getInventoryLevel(locationGid, inventoryItemGid)
      : undefined;
  return commitInventoryWebhook(
    settings,
    session.id,
    webhookId,
    locationGid,
    inventoryItemGid,
    level,
  );
}
