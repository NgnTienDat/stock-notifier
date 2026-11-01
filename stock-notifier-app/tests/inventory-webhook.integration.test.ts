import { randomUUID } from "node:crypto";
import { env } from "node:process";
import { Session } from "@shopify/shopify-api";
import type { AdminGraphqlClient } from "@shopify/shopify-app-react-router/server";
import type { ActionFunctionArgs } from "react-router";
import { afterAll, afterEach, beforeEach, expect, test, vi } from "vitest";
import db from "../app/db.server";
import { authenticate } from "../app/shopify.server";
import { action } from "../app/routes/webhooks.inventory";
import { processInventoryWebhook } from "../app/modules/inventory/inventory-webhook.service.server";
import { processNotificationForShop } from "../app/modules/notifications/notification-worker.server";
import { deleteUninstalledSessions } from "../app/modules/inventory/inventory-webhook.repository.server";
import {
  commitInventorySync,
  getInventorySyncSettings,
} from "../app/modules/inventory/inventory.repository.server";
import {
  saveLocationSettings,
  saveLowStockThreshold,
} from "../app/modules/settings/settings.repository.server";
import type { InventoryLevelData } from "../app/modules/shopify/graphql/types";

const failure = vi.hoisted(() => ({ enabled: false }));
vi.mock("../app/shopify.server", () => ({
  authenticate: { webhook: vi.fn() },
}));
vi.mock("../app/db.server", async () => {
  const { PrismaClient } = await import("@prisma/client");
  return {
    default: new PrismaClient().$extends({
      query: {
        webhookEvent: {
          create({ args, query }) {
            if (failure.enabled)
              throw new Error("Injected delivery write failure");
            return query(args);
          },
        },
      },
    }),
  };
});
const url = new URL(env.DATABASE_URL ?? "http://missing");
if (
  !["localhost", "127.0.0.1"].includes(url.hostname) ||
  url.port !== "5433" ||
  url.pathname !== "/stocknotifier"
) {
  throw new Error(
    "Webhook tests require the local Compose database on port 5433",
  );
}
const locationGid = "gid://shopify/Location/1";
const otherLocation = "gid://shopify/Location/3";
const inventoryItemGid = "gid://shopify/InventoryItem/2";
const oldDate = new Date("2026-10-01T00:00:00Z");
let shop: string;
let otherShop: string;
let session: Session;
let graphql: ReturnType<typeof vi.fn<AdminGraphqlClient>>;

beforeEach(async () => {
  failure.enabled = false;
  shop = `webhook-${randomUUID()}.myshopify.com`;
  otherShop = `webhook-other-${randomUUID()}.myshopify.com`;
  session = new Session({
    id: `offline_${shop}`,
    shop,
    state: "",
    isOnline: false,
    accessToken: "fixture-only",
  });
  await db.shopSettings.createMany({
    data: [shop, otherShop].map((shopDomain) => ({
      shopDomain,
      locationGid,
      lastSyncedAt: oldDate,
      updatedAt: oldDate,
    })),
  });
  await db.session.create({
    data: {
      id: session.id,
      shop,
      state: "",
      isOnline: false,
      accessToken: "fixture-only",
    },
  });
  graphql = vi.fn<AdminGraphqlClient>().mockImplementation(async () => page(4));
  vi.mocked(authenticate.webhook).mockImplementation(async (request) =>
    context(
      request.headers.get("X-Shopify-Webhook-Id")!,
      request.headers.get("X-Shopify-Topic")!,
      await request.json(),
    ),
  );
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  failure.enabled = false;
  const shops = { in: [shop, otherShop] };
  await db.$transaction([
    db.webhookEvent.deleteMany({ where: { shopDomain: shops } }),
    db.inventoryAlert.deleteMany({
      where: { inventoryLevel: { shopDomain: shops } },
    }),
    db.inventoryLevel.deleteMany({ where: { shopDomain: shops } }),
    db.shopSettings.deleteMany({ where: { shopDomain: shops } }),
    db.session.deleteMany({ where: { shop: shops } }),
  ]);
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
afterAll(() => db.$disconnect());

type Context = Awaited<ReturnType<typeof authenticate.webhook>>;
function context(
  webhookId: string = randomUUID(),
  topic = "INVENTORY_LEVELS_UPDATE",
  payload = {
    inventory_item_id: 2,
    location_id: 1,
    available: 999,
    updated_at: "2000-01-01T00:00:00Z",
  },
): Context {
  return {
    shop,
    session,
    admin: { graphql },
    webhookId,
    topic,
    payload,
  } as unknown as Context;
}
function deliver(
  id = randomUUID(),
  topic = "INVENTORY_LEVELS_UPDATE",
  payload?: Record<string, unknown>,
) {
  return action({
    request: new Request("https://app.test/webhooks/inventory", {
      method: "POST",
      headers: {
        "X-Shopify-Webhook-Id": id,
        "X-Shopify-Topic": topic,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload ?? context().payload),
    }),
  } as ActionFunctionArgs);
}
function page(
  quantity: number,
  overrides: {
    connected?: boolean;
    tracked?: boolean;
    deleted?: boolean;
    activeLocation?: boolean;
    updatedAt?: string;
  } = {},
) {
  return new Response(
    JSON.stringify({
      data: {
        location: {
          id: locationGid,
          isActive: overrides.activeLocation ?? true,
        },
        inventoryItem: overrides.deleted
          ? null
          : {
              id: inventoryItemGid,
              sku: null,
              tracked: overrides.tracked ?? true,
              variants: {
                nodes: [
                  {
                    id: "gid://shopify/ProductVariant/7",
                    title: "Variant",
                    product: {
                      id: "gid://shopify/Product/8",
                      title: "Product",
                    },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
              inventoryLevel:
                overrides.connected === false
                  ? null
                  : {
                      id: "gid://shopify/InventoryLevel/1?inventory_item_id=2",
                      isActive: true,
                      quantities: [{ name: "available", quantity }],
                      updatedAt: overrides.updatedAt ?? "2026-11-01T00:00:00Z",
                    },
            },
      },
    }),
  );
}
function item(quantity: number): InventoryLevelData {
  return {
    shopDomain: shop,
    locationGid,
    inventoryItemGid,
    inventoryLevelGid: "gid://shopify/InventoryLevel/1?inventory_item_id=2",
    variants: [],
    sku: null,
    availableQuantity: quantity,
    shopifyUpdatedAt: oldDate,
  };
}
async function seed(shopDomain = shop, location = locationGid) {
  return db.inventoryLevel.create({
    data: {
      shopDomain,
      locationGid: location,
      inventoryItemGid,
      variants: [],
      availableQuantity: 10,
      isLowStock: false,
      shopifyUpdatedAt: oldDate,
      syncedAt: oldDate,
    },
  });
}
async function snapshot() {
  return {
    settings: await db.shopSettings.findUniqueOrThrow({
      where: { shopDomain: shop },
    }),
    levels: await db.inventoryLevel.findMany({
      where: { shopDomain: shop },
      orderBy: { id: "asc" },
    }),
    alerts: await db.inventoryAlert.findMany({
      where: { inventoryLevel: { shopDomain: shop } },
      orderBy: { id: "asc" },
    }),
    events: await db.webhookEvent.findMany({
      where: { shopDomain: shop },
      orderBy: { id: "asc" },
    }),
  };
}
function barrier() {
  let count = 0;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async () => {
    if (++count === 2) release();
    await ready;
    return page(4);
  };
}

test("update rereads GraphQL instead of payload quantity/time; shared engine creates/resolves without advancing full-sync baseline", async () => {
  await seed();
  expect(
    (await deliver()).status,
    JSON.stringify(vi.mocked(console.error).mock.calls),
  ).toBe(200);
  let saved = await snapshot();
  expect(saved.levels[0]).toMatchObject({
    availableQuantity: 4,
    isLowStock: true,
    isCurrent: true,
    sku: null,
  });
  expect(saved.levels[0].variants).toHaveLength(1);
  expect(saved.alerts).toHaveLength(1);
  expect(saved.alerts[0]).toMatchObject({
    status: "ACTIVE",
    quantityAtTrigger: 4,
    thresholdAtTrigger: 5,
  });
  expect(saved.settings.lastSyncedAt).toEqual(oldDate);
  graphql.mockImplementation(async () => page(8));
  expect((await deliver()).status).toBe(200);
  saved = await snapshot();
  expect(saved.alerts[0].status).toBe("RESOLVED");
  expect(saved.settings.lastSyncedAt).toEqual(oldDate);
});

test("duplicate deliveries, including concurrent duplicates, commit only one event/active alert", async () => {
  await seed();
  graphql.mockImplementation(barrier());
  const id = randomUUID();
  const results = await Promise.all([deliver(id), deliver(id)]);
  expect(results.map((result) => result.status)).toEqual([200, 200]);
  expect((await snapshot()).events).toHaveLength(1);
  expect((await snapshot()).alerts).toHaveLength(1);
  graphql.mockClear();
  expect((await deliver(id)).status).toBe(200);
  expect(graphql).not.toHaveBeenCalled();
});

test("distinct concurrent webhooks reject a superseded read; retry commits without a second active alert", async () => {
  await seed();
  graphql.mockImplementation(barrier());
  const ids = [randomUUID(), randomUUID()];
  const results = await Promise.all(ids.map((id) => deliver(id)));
  expect(results.map((result) => result.status).sort()).toEqual([200, 503]);
  expect((await snapshot()).events).toHaveLength(1);
  graphql.mockImplementation(async () => page(3));
  expect(
    (await deliver(ids[results.findIndex((result) => result.status === 503)]))
      .status,
  ).toBe(200);
  expect((await snapshot()).alerts).toHaveLength(1);
  expect((await snapshot()).events).toHaveLength(2);
});

test("connect/new items and pre-full-sync webhooks establish item baseline without creating alerts", async () => {
  expect((await deliver(randomUUID(), "INVENTORY_LEVELS_CONNECT")).status).toBe(
    200,
  );
  expect((await snapshot()).alerts).toHaveLength(0);
  await db.shopSettings.update({
    where: { shopDomain: shop },
    data: { lastSyncedAt: null },
  });
  await db.inventoryLevel.updateMany({
    where: { shopDomain: shop },
    data: { isLowStock: false, availableQuantity: 10 },
  });
  expect((await deliver()).status).toBe(200);
  const saved = await snapshot();
  expect(saved.alerts).toHaveLength(0);
  expect(saved.settings.lastSyncedAt).toBeNull();
});

test.each(["disconnected", "deleted", "untracked", "invalid-location"])(
  "%s invalidates only the scoped snapshot and resolves its active alert",
  async (kind) => {
    await seed();
    await deliver();
    graphql.mockImplementation(async () =>
      page(0, {
        connected: kind !== "disconnected",
        deleted: kind === "deleted",
        tracked: kind !== "untracked",
        activeLocation: kind !== "invalid-location",
      }),
    );
    expect(
      (
        await deliver(randomUUID(), "INVENTORY_LEVELS_DISCONNECT", {
          inventory_item_id: 2,
          location_id: 1,
        })
      ).status,
    ).toBe(200);
    const saved = await snapshot();
    expect(saved.levels[0]).toMatchObject({
      isCurrent: false,
      availableQuantity: 4,
    });
    expect(saved.alerts[0]).toMatchObject({
      status: "RESOLVED",
      resolvedAt: expect.any(Date),
    });
    expect(saved.settings.lastSyncedAt).toEqual(oldDate);
  },
);

test("out-of-order disconnect after reconnect and old update payload reconcile current state; older API timestamps never overwrite newer data", async () => {
  await seed();
  await deliver();
  graphql.mockImplementation(async () =>
    page(9, { updatedAt: "2026-11-02T00:00:00Z" }),
  );
  await deliver(randomUUID(), "INVENTORY_LEVELS_CONNECT");
  await deliver(randomUUID(), "INVENTORY_LEVELS_DISCONNECT", {
    inventory_item_id: 2,
    location_id: 1,
  });
  expect((await snapshot()).levels[0]).toMatchObject({
    isCurrent: true,
    availableQuantity: 9,
  });
  graphql.mockImplementation(async () => page(1));
  expect((await deliver()).status).toBe(200);
  expect((await snapshot()).levels[0]).toMatchObject({ availableQuantity: 9 });
  expect(
    (await snapshot()).alerts.filter((alert) => alert.status === "ACTIVE"),
  ).toHaveLength(0);
});

test("delivery write failure rolls back inventory, alert creation/resolution and version; API errors remain retryable", async () => {
  await seed();
  const initial = await snapshot();
  const id = randomUUID();
  failure.enabled = true;
  expect((await deliver(id)).status).toBe(503);
  expect(await snapshot()).toEqual(initial);
  failure.enabled = false;
  expect((await deliver(id)).status).toBe(200);
  const active = await snapshot();
  failure.enabled = true;
  graphql.mockImplementation(async () => page(9));
  expect((await deliver()).status).toBe(503);
  expect(await snapshot()).toEqual(active);
  failure.enabled = false;
  graphql.mockRejectedValue(new Response(null, { status: 429 }));
  expect((await deliver()).status).toBe(503);
  expect(await snapshot()).toEqual(active);
});

test("webhook invalidates a running manual scan; completed manual sync invalidates a webhook read", async () => {
  await seed();
  const settings = { ...(await getInventorySyncSettings(shop))!, locationGid };
  await deliver();
  const afterWebhook = await snapshot();
  await expect(
    commitInventorySync(settings, [item(10)], new Date()),
  ).rejects.toThrow("Settings changed");
  expect(await snapshot()).toEqual(afterWebhook);
  graphql.mockImplementationOnce(async () => {
    await commitInventorySync(
      { ...(await getInventorySyncSettings(shop))!, locationGid },
      [],
      new Date(Date.now() + 1000),
    );
    return page(4);
  });
  expect((await deliver()).status).toBe(503);
  expect((await snapshot()).levels[0].isCurrent).toBe(false);
  expect((await snapshot()).events).toHaveLength(1);
});

test("location A→B→A and threshold changes during API read reject old results without recording delivery", async () => {
  await seed();
  graphql.mockImplementationOnce(async () => {
    await saveLocationSettings(shop, {
      locationGid: otherLocation,
      locationName: "Other",
    });
    await saveLocationSettings(shop, { locationGid, locationName: "Original" });
    return page(4);
  });
  expect((await deliver()).status).toBe(503);
  expect((await snapshot()).settings.lastSyncedAt).toBeNull();
  expect((await snapshot()).events).toHaveLength(0);
  graphql.mockImplementationOnce(async () => {
    await saveLowStockThreshold(shop, 1);
    return page(4);
  });
  expect((await deliver()).status).toBe(503);
  expect((await snapshot()).events).toHaveLength(0);
});

test("ignores other locations, separates delivery IDs by tenant and refuses foreign sessions", async () => {
  const foreign = await seed(otherShop);
  const otherLoc = await seed(shop, otherLocation);
  const id = randomUUID();
  await db.webhookEvent.create({
    data: { shopDomain: otherShop, webhookId: id },
  });
  expect(
    (
      await deliver(id, "INVENTORY_LEVELS_UPDATE", {
        inventory_item_id: 2,
        location_id: 3,
      })
    ).status,
  ).toBe(200);
  expect(graphql).not.toHaveBeenCalled();
  expect(
    await db.inventoryLevel.findMany({
      where: { id: { in: [foreign.id, otherLoc.id] } },
      orderBy: { id: "asc" },
    }),
  ).toEqual([foreign, otherLoc].sort((a, b) => a.id.localeCompare(b.id)));
  const invalid = { ...context(), shop: otherShop } as Context;
  await expect(processInventoryWebhook(invalid)).rejects.toThrow(
    "session shop",
  );
  expect((await snapshot()).alerts).toHaveLength(0);
});

test("missing sessions/settings and uninstall during API read never resurrect inventory or mark delivery processed", async () => {
  const missing = {
    ...context(),
    admin: undefined,
    session: undefined,
  } as Context;
  expect(await processInventoryWebhook(missing)).toBe("session_missing");
  await db.shopSettings.update({
    where: { shopDomain: shop },
    data: { locationGid: null },
  });
  expect(await processInventoryWebhook(context())).toBe("settings_missing");
  await db.shopSettings.update({
    where: { shopDomain: shop },
    data: { locationGid },
  });
  await seed();
  const before = await snapshot();
  graphql.mockImplementationOnce(async () => {
    await deleteUninstalledSessions(shop);
    return page(4);
  });
  expect((await deliver()).status).toBe(200);
  expect(await snapshot()).toEqual(before);
  expect(await db.session.count({ where: { shop } })).toBe(0);
});

test("a busy shop lock fails promptly without consuming the delivery; retry succeeds after release", async () => {
  await seed();
  let release!: () => void;
  let locked!: () => void;
  const held = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const done = new Promise<void>((resolve) => {
    release = resolve;
  });
  const holder = db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "shopDomain" FROM "ShopSettings" WHERE "shopDomain" = ${shop} FOR UPDATE`;
    locked();
    await done;
  });
  await held;
  const id = randomUUID();
  try {
    expect((await deliver(id)).status).toBe(503);
    expect((await snapshot()).events).toHaveLength(0);
    expect((await snapshot()).levels[0].availableQuantity).toBe(10);
  } finally {
    release();
    await holder;
  }
  expect((await deliver(id)).status).toBe(200);
});

test("webhook commits the notification before responding but never calls Telegram in the request", async () => {
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "fixture-only-token");
  const telegram = vi
    .fn<typeof fetch>()
    .mockImplementation(async () => new Response(JSON.stringify({ ok: true })));
  vi.stubGlobal("fetch", telegram);
  await db.shopSettings.update({
    where: { shopDomain: shop },
    data: { telegramChatId: "-100123" },
  });
  await seed();
  const id = randomUUID();
  expect((await deliver(id)).status).toBe(200);
  expect(telegram).not.toHaveBeenCalled();
  expect((await snapshot()).alerts[0]).toMatchObject({
    notificationStatus: "PENDING",
    notificationNextAttemptAt: expect.any(Date),
  });
  expect((await deliver(id)).status).toBe(200);
  await processNotificationForShop(shop);
  expect(telegram).toHaveBeenCalledTimes(1);
  expect((await snapshot()).alerts[0]).toMatchObject({
    notificationStatus: "SENT",
  });
});
