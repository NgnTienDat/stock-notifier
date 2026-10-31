import { randomUUID } from "node:crypto";
import { env } from "node:process";
import { PrismaClient } from "@prisma/client";
import { Session } from "@shopify/shopify-api";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import { afterAll, afterEach, beforeEach, expect, test } from "vitest";

const databaseUrl = new URL(env.DATABASE_URL ?? "http://missing");
if (
  !["localhost", "127.0.0.1"].includes(databaseUrl.hostname) ||
  databaseUrl.port !== "5433" ||
  databaseUrl.pathname !== "/stocknotifier"
) {
  throw new Error(
    "Database tests require the local Compose stocknotifier database on port 5433",
  );
}

const db = new PrismaClient();
let shopDomain: string;
let otherShopDomain: string;

beforeEach(async () => {
  shopDomain = `foundation-${randomUUID()}.myshopify.com`;
  otherShopDomain = `foundation-${randomUUID()}.myshopify.com`;
  await db.shopSettings.createMany({
    data: [{ shopDomain }, { shopDomain: otherShopDomain }],
  });
});

afterEach(async () => {
  // Delete only this test's exact shop IDs; never clear existing merchant data.
  const shops = { in: [shopDomain, otherShopDomain] };
  await db.$transaction([
    db.inventoryAlert.deleteMany({
      where: { inventoryLevel: { shopDomain: shops } },
    }),
    db.inventoryLevel.deleteMany({ where: { shopDomain: shops } }),
    db.webhookEvent.deleteMany({ where: { shopDomain: shops } }),
    db.shopSettings.deleteMany({ where: { shopDomain: shops } }),
    db.session.deleteMany({ where: { shop: shops } }),
  ]);
});

afterAll(() => db.$disconnect());

function inventoryData() {
  return {
    shopDomain,
    locationGid: "gid://shopify/Location/1",
    inventoryItemGid: "gid://shopify/InventoryItem/271878346596884015",
    availableQuantity: 3,
    isLowStock: true,
    variants: [
      {
        variantGid: "gid://shopify/ProductVariant/1",
        variantTitle: "Small",
        productGid: "gid://shopify/Product/1",
        productTitle: "Shirt",
      },
      {
        variantGid: "gid://shopify/ProductVariant/2",
        variantTitle: "Medium",
        productGid: "gid://shopify/Product/2",
        productTitle: "Summer Shirt",
      },
    ],
  };
}

test("reads/writes one item with multiple variants, defaults, and current-state metadata", async () => {
  const item = await db.inventoryLevel.create({ data: inventoryData() });
  const saved = await db.inventoryLevel.findFirstOrThrow({
    where: { id: item.id, shopDomain, locationGid: item.locationGid },
  });
  expect(saved.variants).toEqual(inventoryData().variants);
  expect(saved.inventoryItemGid).toBe(inventoryData().inventoryItemGid);
  expect(saved.isCurrent).toBe(true);
  expect(saved.sku).toBeNull();
  expect(
    (await db.shopSettings.findUniqueOrThrow({ where: { shopDomain } }))
      .lowStockThreshold,
  ).toBe(5);
  await db.inventoryLevel.update({
    where: { id: item.id },
    data: { isCurrent: false },
  });
  expect(
    await db.inventoryLevel.count({ where: { shopDomain, isCurrent: true } }),
  ).toBe(0);
  expect(await db.inventoryLevel.count({ where: { shopDomain } })).toBe(1);
});

test("enforces item uniqueness within a shop/location while allowing other scopes", async () => {
  await db.inventoryLevel.create({ data: inventoryData() });
  await expect(
    db.inventoryLevel.create({ data: inventoryData() }),
  ).rejects.toMatchObject({ code: "P2002" });
  await db.inventoryLevel.create({
    data: { ...inventoryData(), locationGid: "gid://shopify/Location/2" },
  });
  await db.inventoryLevel.create({
    data: { ...inventoryData(), shopDomain: otherShopDomain },
  });
  expect(
    await db.inventoryLevel.count({
      where: { shopDomain, locationGid: "gid://shopify/Location/1" },
    }),
  ).toBe(1);
});

test("the partial index allows one concurrent ACTIVE alert and multiple resolved cycles", async () => {
  const item = await db.inventoryLevel.create({ data: inventoryData() });
  const alert = {
    inventoryLevelId: item.id,
    quantityAtTrigger: 3,
    thresholdAtTrigger: 5,
  };
  const results = await Promise.allSettled([
    db.inventoryAlert.create({ data: alert }),
    db.inventoryAlert.create({ data: alert }),
  ]);
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  const rejected = results.find((result) => result.status === "rejected");
  expect(rejected?.status === "rejected" && rejected.reason).toMatchObject({
    code: "P2002",
  });
  await db.inventoryAlert.updateMany({
    where: { inventoryLevelId: item.id, status: "ACTIVE" },
    data: { status: "RESOLVED", resolvedAt: new Date() },
  });
  await db.inventoryAlert.create({
    data: { ...alert, status: "RESOLVED", resolvedAt: new Date() },
  });
  await db.inventoryAlert.create({ data: alert });
  expect(
    await db.inventoryAlert.count({
      where: { inventoryLevelId: item.id, status: "RESOLVED" },
    }),
  ).toBe(2);
  expect(
    await db.inventoryAlert.count({
      where: { inventoryLevelId: item.id, status: "ACTIVE" },
    }),
  ).toBe(1);
});

test("deduplicates delivery IDs per shop", async () => {
  const delivery = { shopDomain, webhookId: randomUUID() };
  await db.webhookEvent.create({ data: delivery });
  await expect(
    db.webhookEvent.create({ data: delivery }),
  ).rejects.toMatchObject({ code: "P2002" });
  await db.webhookEvent.create({
    data: { ...delivery, shopDomain: otherShopDomain },
  });
});

test("rolls back inventory, alert, and deduplication record together", async () => {
  const item = await db.inventoryLevel.create({
    data: { ...inventoryData(), availableQuantity: 8, isLowStock: false },
  });
  const webhookId = randomUUID();
  const failure = new Error("simulated failure before commit");
  await expect(
    db.$transaction(async (tx) => {
      await tx.inventoryLevel.update({
        where: { id: item.id },
        data: { availableQuantity: 3, isLowStock: true },
      });
      await tx.inventoryAlert.create({
        data: {
          inventoryLevelId: item.id,
          quantityAtTrigger: 3,
          thresholdAtTrigger: 5,
        },
      });
      await tx.webhookEvent.create({ data: { shopDomain, webhookId } });
      throw failure;
    }),
  ).rejects.toBe(failure);
  expect(
    await db.inventoryLevel.findFirstOrThrow({
      where: { id: item.id, shopDomain },
    }),
  ).toMatchObject({ availableQuantity: 8, isLowStock: false });
  expect(
    await db.inventoryAlert.count({ where: { inventoryLevelId: item.id } }),
  ).toBe(0);
  expect(
    await db.webhookEvent.count({ where: { shopDomain, webhookId } }),
  ).toBe(0);
});

test("rejects negative thresholds and preserves referenced alert history", async () => {
  await expect(
    db.shopSettings.update({
      where: { shopDomain },
      data: { lowStockThreshold: -1 },
    }),
  ).rejects.toThrow();
  const item = await db.inventoryLevel.create({ data: inventoryData() });
  await db.inventoryAlert.create({
    data: {
      inventoryLevelId: item.id,
      quantityAtTrigger: 3,
      thresholdAtTrigger: 5,
      status: "RESOLVED",
      resolvedAt: new Date(),
    },
  });
  await expect(
    db.inventoryLevel.delete({ where: { id: item.id } }),
  ).rejects.toMatchObject({ code: "P2003" });
  expect(
    await db.inventoryAlert.count({ where: { inventoryLevelId: item.id } }),
  ).toBe(1);
});

test("the unchanged Shopify session adapter persists offline tokens across client reconnects", async () => {
  const writer = new PrismaClient();
  const reader = new PrismaClient();
  const session = new Session({
    id: `offline_${shopDomain}`,
    shop: shopDomain,
    state: "database-foundation-test",
    isOnline: false,
    scope: "read_inventory,read_products",
    accessToken: "test-only-access-token",
    expires: new Date(Date.now() + 3600000),
    refreshToken: "test-only-refresh-token",
    refreshTokenExpires: new Date(Date.now() + 7200000),
  });
  try {
    expect(await new PrismaSessionStorage(writer).storeSession(session)).toBe(
      true,
    );
    await writer.$disconnect();
    const stored = await new PrismaSessionStorage(reader).loadSession(
      session.id,
    );
    expect(stored).toMatchObject({
      id: session.id,
      shop: shopDomain,
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      refreshTokenExpires: session.refreshTokenExpires,
      isOnline: false,
      expires: session.expires,
    });
  } finally {
    await writer.$disconnect();
    await reader.$disconnect();
  }
});
