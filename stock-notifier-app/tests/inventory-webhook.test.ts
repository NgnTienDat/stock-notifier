import "@shopify/shopify-app-react-router/adapters/node";
import { createHmac } from "node:crypto";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import type { ActionFunctionArgs } from "react-router";
import { afterEach, expect, test, vi } from "vitest";
import { authenticate } from "../app/shopify.server";
import { action } from "../app/routes/webhooks.inventory";
import {
  parseInventoryWebhook,
  decodeInventoryWebhookBody,
  processInventoryWebhook,
} from "../app/modules/inventory/inventory-webhook.service.server";

vi.mock("../app/shopify.server", () => ({
  authenticate: { webhook: vi.fn() },
}));
vi.mock(
  "../app/modules/inventory/inventory-webhook.service.server",
  async (original) => ({
    ...(await original<
      typeof import("../app/modules/inventory/inventory-webhook.service.server")
    >()),
    processInventoryWebhook: vi.fn(),
  }),
);

const secret = "unit-test-only-webhook-secret";
const loadSession = vi.fn().mockResolvedValue(undefined);
const app = shopifyApp({
  apiKey: "unit-test-only-api-key",
  apiSecretKey: secret,
  apiVersion: ApiVersion.July26,
  appUrl: "https://app.test",
  distribution: AppDistribution.AppStore,
  sessionStorage: {
    loadSession,
    storeSession: vi.fn(),
    deleteSession: vi.fn(),
    deleteSessions: vi.fn(),
    findSessionsByShop: vi.fn(),
  },
});
afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

function request(
  valid: boolean,
  body = '{"inventory_item_id":2,"location_id":1}',
) {
  return new Request(
    "https://app.test/webhooks/inventory?shop=attacker.myshopify.com",
    {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "X-Shopify-Shop-Domain": "fixture.myshopify.com",
        "X-Shopify-Topic": "inventory_levels/update",
        "X-Shopify-API-Version": "2026-07",
        "X-Shopify-Webhook-Id": "delivery-1",
        "X-Shopify-Hmac-Sha256": valid
          ? createHmac("sha256", secret).update(body).digest("base64")
          : "invalid",
      },
    },
  );
}
test("real Shopify authentication rejects invalid HMAC before session lookup or business logic", async () => {
  vi.mocked(authenticate.webhook).mockImplementation(app.authenticate.webhook);
  await expect(
    action({ request: request(false) } as ActionFunctionArgs),
  ).rejects.toMatchObject({ status: 401 });
  expect(loadSession).not.toHaveBeenCalled();
  expect(processInventoryWebhook).not.toHaveBeenCalled();
});
test("real Shopify authentication passes verified shop, topic and delivery ID to service", async () => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.mocked(authenticate.webhook).mockImplementation(app.authenticate.webhook);
  vi.mocked(processInventoryWebhook).mockResolvedValue("session_missing");
  expect(
    (await action({ request: request(true) } as ActionFunctionArgs)).status,
  ).toBe(200);
  expect(processInventoryWebhook).toHaveBeenCalledWith(
    expect.objectContaining({
      shop: "fixture.myshopify.com",
      topic: "INVENTORY_LEVELS_UPDATE",
      webhookId: "delivery-1",
    }),
  );
});
test("payload validation rejects invalid topics, missing delivery IDs and unsafe/truncated numeric IDs", () => {
  const decoded = decodeInventoryWebhookBody(
    '{"location_id":24826418,"inventory_item_id":271878346596884015}',
  );
  expect(
    parseInventoryWebhook("INVENTORY_LEVELS_DISCONNECT", decoded, "delivery"),
  ).toMatchObject({
    inventoryItemGid: "gid://shopify/InventoryItem/271878346596884015",
  });
  expect(
    parseInventoryWebhook(
      "INVENTORY_LEVELS_DISCONNECT",
      { location_id: "1", inventory_item_id: "271878346596884015" },
      "delivery",
    ),
  ).toMatchObject({
    inventoryItemGid: "gid://shopify/InventoryItem/271878346596884015",
  });
  for (const payload of [
    {},
    { location_id: 1, inventory_item_id: 2.5 },
    { location_id: 1, inventory_item_id: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    expect(() =>
      parseInventoryWebhook("INVENTORY_LEVELS_UPDATE", payload, "delivery"),
    ).toThrow();
  }
  expect(() =>
    parseInventoryWebhook("APP_UNINSTALLED", {}, "delivery"),
  ).toThrow();
  expect(() =>
    parseInventoryWebhook("INVENTORY_LEVELS_UPDATE", {}, ""),
  ).toThrow();
});
