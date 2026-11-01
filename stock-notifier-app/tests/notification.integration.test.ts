import { randomUUID } from "node:crypto";
import { env } from "node:process";
import { afterAll, afterEach, beforeEach, expect, test, vi } from "vitest";
import db from "../app/db.server";
import {
  commitInventorySync,
  getInventorySyncSettings,
} from "../app/modules/inventory/inventory.repository.server";
import { processNotificationForShop } from "../app/modules/notifications/notification-worker.server";
import {
  claimNotification,
  finishNotification,
} from "../app/modules/notifications/notification.repository.server";
import {
  testTelegramSettings,
  saveTelegramSettings,
} from "../app/modules/notifications/telegram-settings.service.server";
import {
  saveLowStockThreshold,
  saveLocationSettings,
} from "../app/modules/settings/settings.repository.server";
import type { InventoryLevelData } from "../app/modules/shopify/graphql/types";

const failure = vi.hoisted(() => ({ enabled: false }));
vi.mock("../app/db.server", async () => {
  const { PrismaClient } = await import("@prisma/client");
  return {
    default: new PrismaClient().$extends({
      query: {
        shopSettings: {
          update({ args, query }) {
            if (failure.enabled)
              throw new Error("Injected final settings failure");
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
)
  throw new Error(
    "Notification tests require local Compose PostgreSQL on 5433",
  );
const locationGid = "gid://shopify/Location/1";
const oldDate = new Date("2026-10-01T00:00:00Z");
let shop: string;
let otherShop: string;
const fetchMock = vi.fn<typeof fetch>();

beforeEach(async () => {
  failure.enabled = false;
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "fixture-only-token");
  vi.stubGlobal("fetch", fetchMock);
  fetchMock
    .mockReset()
    .mockImplementation(
      async () =>
        new Response(JSON.stringify({ ok: true, result: { message_id: 1 } })),
    );
  shop = `notification-${randomUUID()}.myshopify.com`;
  otherShop = `notification-other-${randomUUID()}.myshopify.com`;
  await db.shopSettings.createMany({
    data: [shop, otherShop].map((shopDomain, i) => ({
      shopDomain,
      locationGid,
      locationName: "Warehouse",
      lowStockThreshold: 5,
      lastSyncedAt: oldDate,
      telegramChatId: i ? "456" : "-100123",
      updatedAt: oldDate,
    })),
  });
  await db.session.createMany({
    data: [shop, otherShop].map((shop) => ({
      id: `offline_${shop}`,
      shop,
      state: "",
      isOnline: false,
      accessToken: "fixture-only",
    })),
  });
  for (const shopDomain of [shop, otherShop])
    await db.inventoryLevel.create({
      data: {
        shopDomain,
        locationGid,
        inventoryItemGid: "gid://shopify/InventoryItem/2",
        variants: [{ productTitle: "Product", variantTitle: "Blue" }],
        sku: null,
        availableQuantity: 10,
        isLowStock: false,
        shopifyUpdatedAt: oldDate,
        syncedAt: oldDate,
      },
    });
});
afterEach(async () => {
  vi.useRealTimers();
  failure.enabled = false;
  const scope = { shopDomain: { in: [shop, otherShop] } };
  await db.$transaction([
    db.inventoryAlert.deleteMany({ where: { inventoryLevel: scope } }),
    db.inventoryLevel.deleteMany({ where: scope }),
    db.shopSettings.deleteMany({ where: scope }),
    db.session.deleteMany({ where: { shop: { in: [shop, otherShop] } } }),
  ]);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
afterAll(() => db.$disconnect());

test("database-clock leases remain valid when the Node clock is ahead", async () => {
  await scan(4);
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 95000 });
  expect(await processNotificationForShop(shop)).toBe(true);
  expect((await alerts())[0]).toMatchObject({
    notificationStatus: "SENT",
    notificationAttempts: 1,
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

async function scan(quantity: number, shopDomain = shop) {
  const settings = {
    ...(await getInventorySyncSettings(shopDomain))!,
    locationGid,
  };
  const level: InventoryLevelData = {
    shopDomain,
    locationGid,
    inventoryItemGid: "gid://shopify/InventoryItem/2",
    inventoryLevelGid: "gid://shopify/InventoryLevel/1?inventory_item_id=2",
    sku: null,
    variants: [
      {
        productGid: "gid://shopify/Product/3",
        productTitle: "Product",
        variantGid: "gid://shopify/ProductVariant/4",
        variantTitle: "Blue",
      },
    ],
    availableQuantity: quantity,
    shopifyUpdatedAt: oldDate,
  };
  return commitInventorySync(settings, [level], new Date());
}
function alerts(shopDomain = shop) {
  return db.inventoryAlert.findMany({
    where: { inventoryLevel: { shopDomain } },
    orderBy: { triggeredAt: "asc" },
  });
}
async function due(id: string) {
  await db.inventoryAlert.updateMany({
    where: { id, inventoryLevel: { shopDomain: shop } },
    data: { notificationNextAttemptAt: oldDate },
  });
}

test("manual transition commits a durable job; concurrent workers send once; next low cycle sends a new notification", async () => {
  await scan(5);
  expect(fetchMock).not.toHaveBeenCalled();
  const first = (await alerts())[0];
  expect(first).toMatchObject({
    notificationStatus: "PENDING",
    notificationAttempts: 0,
    notificationChatId: "-100123",
    notificationNextAttemptAt: expect.any(Date),
  });
  const outcomes = await Promise.all([
    processNotificationForShop(shop),
    processNotificationForShop(shop),
  ]);
  expect(outcomes.sort()).toEqual([false, true]);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect((await alerts())[0]).toMatchObject({
    notificationStatus: "SENT",
    notifiedAt: expect.any(Date),
    notificationAttempts: 1,
    notificationNextAttemptAt: null,
  });
  await scan(3);
  expect(await processNotificationForShop(shop)).toBe(false);
  await scan(8);
  expect(await processNotificationForShop(shop)).toBe(false);
  await scan(4);
  expect(await processNotificationForShop(shop)).toBe(true);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(await alerts()).toHaveLength(2);
});

test("baseline and threshold changes never schedule Telegram", async () => {
  await db.shopSettings.update({
    where: { shopDomain: shop },
    data: { lastSyncedAt: null },
  });
  await scan(3);
  await scan(2);
  await scan(6);
  await saveLowStockThreshold(shop, 7);
  await scan(6);
  expect(await processNotificationForShop(shop)).toBe(false);
  expect(await alerts()).toHaveLength(0);
  expect(fetchMock).not.toHaveBeenCalled();
});

test.each(["token", "chat"])(
  "missing %s leaves the new alert unscheduled; later configuration never drains historical PENDING alerts",
  async (missing) => {
    if (missing === "token") vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
    else await saveTelegramSettings(shop, "");
    await scan(4);
    expect((await alerts())[0]).toMatchObject({
      notificationNextAttemptAt: null,
      notificationChatId: null,
      notificationAttempts: 0,
    });
    expect(await processNotificationForShop(shop)).toBe(false);
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "fixture-only-token");
    await saveTelegramSettings(shop, "-100123");
    expect(await processNotificationForShop(shop)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  },
);

test("retry scheduling survives failures, honors Telegram retry_after, and records SENT only after acceptance", async () => {
  await scan(4);
  const id = (await alerts())[0].id;
  fetchMock.mockImplementationOnce(
    async () => new Response(JSON.stringify({ ok: false }), { status: 503 }),
  );
  await processNotificationForShop(shop);
  let saved = (await alerts())[0];
  expect(saved).toMatchObject({
    notificationStatus: "FAILED",
    notifiedAt: null,
    notificationAttempts: 1,
  });
  expect(saved.notificationNextAttemptAt!.getTime()).toBeGreaterThan(
    Date.now(),
  );
  expect(await processNotificationForShop(shop)).toBe(false);
  await due(id);
  fetchMock.mockImplementationOnce(
    async () =>
      new Response(
        JSON.stringify({ ok: false, parameters: { retry_after: 60 } }),
        { status: 429 },
      ),
  );
  const started = Date.now();
  await processNotificationForShop(shop);
  saved = (await alerts())[0];
  expect(saved.notificationNextAttemptAt!.getTime()).toBeGreaterThanOrEqual(
    started + 60000,
  );
  await due(id);
  await processNotificationForShop(shop);
  expect((await alerts())[0]).toMatchObject({
    notificationStatus: "SENT",
    notificationAttempts: 3,
    notifiedAt: expect.any(Date),
    notificationNextAttemptAt: null,
  });
});

test.each([400, 503])(
  "HTTP %i stops at the permanent-error/three-attempt boundary",
  async (status) => {
    await scan(4);
    const id = (await alerts())[0].id;
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ ok: false, error_code: status }), {
          status,
        }),
    );
    const attempts = status === 400 ? 1 : 3;
    for (let n = 0; n < attempts; n++) {
      if (n) await due(id);
      await processNotificationForShop(shop);
    }
    expect((await alerts())[0]).toMatchObject({
      notificationStatus: "FAILED",
      notificationAttempts: attempts,
      notificationNextAttemptAt: null,
      notifiedAt: null,
    });
    expect(await processNotificationForShop(shop)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(attempts);
  },
);

test("expired leases recover after restart; fencing rejects old workers and crash exhaustion becomes FAILED", async () => {
  await scan(4);
  const first = (await claimNotification(shop))!;
  expect(await claimNotification(shop)).toBeNull();
  await db.inventoryAlert.update({
    where: { id: first.id },
    data: { notificationLeaseUntil: oldDate },
  });
  const second = (await claimNotification(shop))!;
  expect(second.token).not.toBe(first.token);
  expect(second.attempt).toBe(2);
  expect((await finishNotification(shop, first)).count).toBe(0);
  await db.inventoryAlert.update({
    where: { id: first.id },
    data: { notificationLeaseUntil: oldDate },
  });
  const third = (await claimNotification(shop))!;
  expect(third.attempt).toBe(3);
  await db.inventoryAlert.update({
    where: { id: first.id },
    data: { notificationLeaseUntil: oldDate },
  });
  expect(await claimNotification(shop)).toBeNull();
  expect((await alerts())[0]).toMatchObject({
    notificationStatus: "FAILED",
    notificationNextAttemptAt: null,
  });
  expect(fetchMock).not.toHaveBeenCalled();
});

test("store isolation and test message use the saved Chat ID without creating alerts", async () => {
  await testTelegramSettings(shop);
  expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string).chat_id).toBe(
    "-100123",
  );
  expect(await alerts()).toHaveLength(0);
  await scan(4);
  await scan(4, otherShop);
  await processNotificationForShop(otherShop);
  expect(JSON.parse(fetchMock.mock.calls[1][1]!.body as string).chat_id).toBe(
    "456",
  );
  expect((await alerts())[0].notificationStatus).toBe("PENDING");
  await processNotificationForShop(shop);
  expect(JSON.parse(fetchMock.mock.calls[2][1]!.body as string).chat_id).toBe(
    "-100123",
  );
});

test.each(["chat", "location", "resolve"])(
  "%s change cancels an unsent job instead of sending to an obsolete destination/scope",
  async (change) => {
    await scan(4);
    if (change === "chat") await saveTelegramSettings(shop, "999");
    else if (change === "location")
      await saveLocationSettings(shop, {
        locationGid: "gid://shopify/Location/8",
        locationName: "Other",
      });
    else await scan(8);
    expect(await processNotificationForShop(shop)).toBe(false);
    expect((await alerts())[0]).toMatchObject({
      notificationStatus: "FAILED",
      notificationNextAttemptAt: null,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  },
);

test("notification enqueue rolls back with inventory/alert transaction; Chat ID edits invalidate in-flight scans without resetting baseline", async () => {
  failure.enabled = true;
  await expect(scan(4)).rejects.toThrow("Injected");
  failure.enabled = false;
  expect(await alerts()).toHaveLength(0);
  expect(await processNotificationForShop(shop)).toBe(false);
  const before = (await getInventorySyncSettings(shop))!;
  await saveTelegramSettings(shop, "999");
  const after = (await getInventorySyncSettings(shop))!;
  expect(after.lastSyncedAt).toEqual(before.lastSyncedAt);
  expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
  expect(fetchMock).not.toHaveBeenCalled();
});
