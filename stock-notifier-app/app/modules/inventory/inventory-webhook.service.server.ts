import type { authenticate } from "../../shopify.server";
import { enqueueWebhook } from "./webhook-job.repository.server";

export class InvalidInventoryWebhookError extends Error {}

export function decodeInventoryWebhookBody(
  rawBody: string,
): Record<string, unknown> {
  // Node 22 JSON source preserves Shopify's 64-bit numeric IDs before Number rounds them.
  const payload = JSON.parse(
    rawBody,
    (key: string, value: unknown, source?: { source: string }) =>
      (key === "inventory_item_id" || key === "location_id" || key === "id") &&
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
  "LOCATIONS_CREATE",
  "LOCATIONS_ACTIVATE",
  "LOCATIONS_DEACTIVATE",
  "LOCATIONS_DELETE",
  "LOCATIONS_UPDATE",
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
  if (topic.startsWith("LOCATIONS_"))
    return {
      locationGid: resourceGid("Location", payload.id),
      inventoryItemGid: undefined,
    };
  return {
    locationGid: resourceGid("Location", payload.location_id),
    inventoryItemGid: resourceGid("InventoryItem", payload.inventory_item_id),
  };
}

export async function processInventoryWebhook(
  context: Awaited<ReturnType<typeof authenticate.webhook>>,
  eventId?: string | null,
) {
  const { shop, topic, webhookId, payload } = context;
  const identifiers = parseInventoryWebhook(topic, payload, webhookId);
  return enqueueWebhook({
    shopDomain: shop,
    topic,
    webhookId,
    eventId,
    ...identifiers,
  });
}
