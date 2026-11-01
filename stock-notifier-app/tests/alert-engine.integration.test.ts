import { randomUUID } from "node:crypto";
import { env } from "node:process";
import { afterAll, afterEach, beforeEach, expect, test, vi } from "vitest";
import db from "../app/db.server";
import {
  commitInventorySync,
  getInventorySyncSettings,
} from "../app/modules/inventory/inventory.repository.server";
import {
  saveLocationSettings,
  saveLowStockThreshold,
} from "../app/modules/settings/settings.repository.server";
import { applyInventoryAlertTransition } from "../app/modules/alerts/alert.service.server";
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
              throw new Error("Injected final settings write failure");
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
    "Alert tests require the local Compose database on port 5433",
  );
}
const locationGid = "gid://shopify/Location/1";
const otherLocation = "gid://shopify/Location/2";
let shopDomain: string;
let otherShop: string;

beforeEach(async () => {
  failure.enabled = false;
  shopDomain = `alert-${randomUUID()}.myshopify.com`;
  otherShop = `alert-other-${randomUUID()}.myshopify.com`;
  await db.shopSettings.createMany({
    data: [shopDomain, otherShop].map((shopDomain) => ({
      shopDomain,
      locationGid,
    })),
  });
});
afterEach(async () => {
  failure.enabled = false;
  const scope = { shopDomain: { in: [shopDomain, otherShop] } };
  await db.$transaction([
    db.inventoryAlert.deleteMany({ where: { inventoryLevel: scope } }),
    db.inventoryLevel.deleteMany({ where: scope }),
    db.shopSettings.deleteMany({ where: scope }),
  ]);
});
afterAll(() => db.$disconnect());

function item(quantity: number, id = "1"): InventoryLevelData {
  return {
    shopDomain,
    locationGid,
    inventoryItemGid: `gid://shopify/InventoryItem/${id}`,
    inventoryLevelGid: `gid://shopify/InventoryLevel/${id}?inventory_item_id=${id}`,
    sku: null,
    variants: [],
    availableQuantity: quantity,
    shopifyUpdatedAt: new Date("2026-10-01T00:00:00Z"),
  };
}
async function settings() {
  return { ...(await getInventorySyncSettings(shopDomain))!, locationGid };
}
async function scan(...items: InventoryLevelData[]) {
  return commitInventorySync(await settings(), items, new Date());
}
async function state() {
  return {
    settings: await db.shopSettings.findUniqueOrThrow({
      where: { shopDomain },
    }),
    levels: await db.inventoryLevel.findMany({
      where: { shopDomain },
      orderBy: { id: "asc" },
    }),
    alerts: await db.inventoryAlert.findMany({
      where: { inventoryLevel: { shopDomain } },
      orderBy: { id: "asc" },
    }),
  };
}
async function alerts() {
  return (await state()).alerts;
}

test("inclusive boundary, repeated low readings, recovery and next cycle preserve alert history", async () => {
  expect(await scan(item(6))).toMatchObject({
    baseline: true,
    alertsCreated: 0,
  });
  expect(await scan(item(5))).toMatchObject({ alertsCreated: 1 });
  const first = (await alerts())[0];
  expect(first).toMatchObject({
    status: "ACTIVE",
    quantityAtTrigger: 5,
    thresholdAtTrigger: 5,
    notificationStatus: "PENDING",
  });
  for (const quantity of [3, 5, 5])
    expect(await scan(item(quantity))).toMatchObject({ alertsCreated: 0 });
  expect(await alerts()).toEqual([first]);
  expect(await scan(item(8))).toMatchObject({ alertsResolved: 1 });
  expect(await scan(item(4))).toMatchObject({ alertsCreated: 1 });
  const history = await alerts();
  expect(history).toHaveLength(2);
  expect(history.find((alert) => alert.id === first.id)).toMatchObject({
    status: "RESOLVED",
    resolvedAt: expect.any(Date),
    quantityAtTrigger: 5,
  });
  expect(history.filter((alert) => alert.status === "ACTIVE")).toHaveLength(1);
});

test("zero threshold includes zero and negative quantities without duplicate alerts", async () => {
  await saveLowStockThreshold(shopDomain, 0);
  await scan(item(1));
  expect(await scan(item(0))).toMatchObject({ alertsCreated: 1 });
  expect(await scan(item(-2))).toMatchObject({ alertsCreated: 0 });
  expect((await alerts())[0]).toMatchObject({
    quantityAtTrigger: 0,
    thresholdAtTrigger: 0,
  });
});

test("low baseline, first-seen items and reactivated snapshots do not alert; stale items resolve", async () => {
  await scan(item(2));
  await scan(item(1), item(0, "new"));
  expect(await alerts()).toHaveLength(0);
  await scan(item(8));
  await scan(item(4));
  expect(await scan()).toMatchObject({ staleCount: 1, alertsResolved: 1 });
  await scan(item(1));
  expect(
    (await alerts()).filter((alert) => alert.status === "ACTIVE"),
  ).toHaveLength(0);
});

test("location changes reset baseline even when returning to an old location", async () => {
  await scan(item(6));
  await scan(item(4));
  await saveLocationSettings(shopDomain, {
    locationGid: otherLocation,
    locationName: "Other",
  });
  await saveLocationSettings(shopDomain, {
    locationGid,
    locationName: "Original",
  });
  expect(await scan(item(3))).toMatchObject({
    baseline: true,
    alertsCreated: 0,
  });
  expect((await alerts())[0].status).toBe("RESOLVED");
});

test("threshold changes rebase without creating alerts and resolve only invalid active alerts", async () => {
  await scan(item(6), item(8, "2"));
  const lastSyncedAt = (await state()).settings.lastSyncedAt;
  await saveLowStockThreshold(shopDomain, 7);
  expect((await state()).settings.lastSyncedAt).toEqual(lastSyncedAt);
  expect(
    (await state()).levels.find(
      (level) => level.inventoryItemGid === item(6).inventoryItemGid,
    )?.isLowStock,
  ).toBe(true);
  expect(await alerts()).toHaveLength(0);
  expect(await scan(item(6), item(8, "2"))).toMatchObject({ alertsCreated: 0 });
  await scan(item(8), item(8, "2"));
  await scan(item(6), item(2, "2"));
  await saveLowStockThreshold(shopDomain, 3);
  const history = await alerts();
  expect(history).toHaveLength(2);
  expect(history.filter((alert) => alert.status === "ACTIVE")).toHaveLength(1);
  expect(history.find((alert) => alert.quantityAtTrigger === 6)?.status).toBe(
    "RESOLVED",
  );
});

test("threshold edits and transition helper isolate the authenticated tenant/location", async () => {
  await scan(item(8));
  const protectedRows = await Promise.all(
    [
      { shopDomain: otherShop, locationGid },
      { shopDomain, locationGid: otherLocation },
    ].map((scope) =>
      db.inventoryLevel.create({
        data: {
          ...scope,
          inventoryItemGid: item(1).inventoryItemGid,
          variants: [],
          availableQuantity: 4,
          isLowStock: true,
          syncedAt: new Date(),
          alerts: { create: { quantityAtTrigger: 4, thresholdAtTrigger: 5 } },
        },
        include: { alerts: true },
      }),
    ),
  );
  await saveLowStockThreshold(shopDomain, 0);
  for (const row of protectedRows) {
    expect(
      await db.inventoryLevel.findUnique({ where: { id: row.id } }),
    ).toMatchObject({ isLowStock: true });
    expect(
      await db.inventoryAlert.findUnique({ where: { id: row.alerts[0].id } }),
    ).toMatchObject({ status: "ACTIVE" });
    await expect(
      db.$transaction((tx) =>
        applyInventoryAlertTransition(
          tx,
          {
            shopDomain,
            locationGid,
            lastSyncedAt: new Date(),
            lowStockThreshold: 5,
          },
          { isLowStock: false, isCurrent: true },
          row,
          new Date(),
        ),
      ),
    ).rejects.toThrow("does not belong");
  }
});

test("creation, resolution and threshold rebase roll back with inventory and final settings write", async () => {
  await scan(item(6));
  const normal = await state();
  failure.enabled = true;
  await expect(scan(item(5))).rejects.toThrow("Injected");
  expect(await state()).toEqual(normal);
  failure.enabled = false;
  await scan(item(5));
  const low = await state();
  failure.enabled = true;
  await expect(scan(item(8))).rejects.toThrow("Injected");
  expect(await state()).toEqual(low);
  await expect(saveLowStockThreshold(shopDomain, 0)).rejects.toThrow(
    "Injected",
  );
  expect(await state()).toEqual(low);
});

test("overlapping scans serialize to one active alert; stale settings/threshold scans cannot commit", async () => {
  await scan(item(6));
  const before = await settings();
  const results = await Promise.allSettled([
    commitInventorySync(before, [item(4)], new Date()),
    commitInventorySync(before, [item(3)], new Date()),
  ]);
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(
    1,
  );
  expect(await alerts()).toHaveLength(1);
  expect(await scan(item(2))).toMatchObject({ alertsCreated: 0 });
  const oldSettings = await settings();
  await saveLowStockThreshold(shopDomain, 1);
  const rebased = await state();
  await expect(
    commitInventorySync(oldSettings, [item(0)], new Date()),
  ).rejects.toThrow("Settings changed");
  expect(await state()).toEqual(rebased);
});

test("partial unique ACTIVE index makes repeated engine application idempotent and rejects direct duplicates", async () => {
  await scan(item(6));
  const currentSettings = await settings();
  const level = (await state()).levels[0];
  const results = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "shopDomain" FROM "ShopSettings" WHERE "shopDomain" = ${shopDomain} FOR UPDATE`;
    const saved = await tx.inventoryLevel.update({
      where: { id: level.id },
      data: { isLowStock: true, availableQuantity: 4 },
    });
    return [
      await applyInventoryAlertTransition(
        tx,
        currentSettings,
        level,
        saved,
        new Date(),
      ),
      await applyInventoryAlertTransition(
        tx,
        currentSettings,
        level,
        saved,
        new Date(),
      ),
    ];
  });
  expect(results.map((result) => result.created)).toEqual([1, 0]);
  await expect(
    db.inventoryAlert.create({
      data: {
        inventoryLevelId: level.id,
        quantityAtTrigger: 4,
        thresholdAtTrigger: 5,
      },
    }),
  ).rejects.toMatchObject({ code: "P2002" });
  expect(await alerts()).toHaveLength(1);
});
