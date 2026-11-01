import { randomUUID } from "node:crypto";
import { env } from "node:process";
import { PrismaClient } from "@prisma/client";
import { Session } from "@shopify/shopify-api";
import type { AdminGraphqlClient } from "@shopify/shopify-app-react-router/server";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { afterAll, afterEach, beforeEach, expect, test, vi } from "vitest";
import db from "../app/db.server";
import { authenticate } from "../app/shopify.server";
import { loader, action } from "../app/routes/app.settings";
import { saveLocationSettings } from "../app/modules/settings/settings.repository.server";

const failure = vi.hoisted(() => ({ enabled: false }));
vi.mock("../app/shopify.server", () => ({ authenticate: { admin: vi.fn() } }));
vi.mock("../app/db.server", async () => {
  const { PrismaClient } = await import("@prisma/client");
  return {
    default: new PrismaClient().$extends({
      query: {
        shopSettings: {
          update({ args, query }) {
            if (failure.enabled)
              throw new Error("Injected settings write failure");
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
    "Location integration tests require the local Compose database on port 5433",
  );
}

const locationA = "gid://shopify/Location/1";
const locationB = "gid://shopify/Location/2";
const locationC = "gid://shopify/Location/3";
const baseline = new Date("2026-11-01T00:00:00Z");
let shopDomain: string;
let otherShop: string;
let graphql: ReturnType<typeof vi.fn<AdminGraphqlClient>>;

beforeEach(() => {
  failure.enabled = false;
  shopDomain = `location-${randomUUID()}.myshopify.com`;
  otherShop = `location-other-${randomUUID()}.myshopify.com`;
  graphql = vi.fn<AdminGraphqlClient>().mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          data: {
            locations: {
              nodes: [locationA, locationB, locationC].map((id) => ({
                id,
                name: `Warehouse ${id.slice(-1)}`,
                isActive: true,
              })),
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        }),
      ),
  );
  const context = {
    admin: { graphql },
    session: new Session({
      id: "fixture",
      shop: shopDomain,
      state: "",
      isOnline: false,
    }),
  };
  vi.mocked(authenticate.admin).mockResolvedValue(
    context as unknown as Awaited<ReturnType<typeof authenticate.admin>>,
  );
});

afterEach(async () => {
  failure.enabled = false;
  const shops = { in: [shopDomain, otherShop] };
  await db.$transaction([
    db.inventoryAlert.deleteMany({
      where: { inventoryLevel: { shopDomain: shops } },
    }),
    db.inventoryLevel.deleteMany({ where: { shopDomain: shops } }),
    db.shopSettings.deleteMany({ where: { shopDomain: shops } }),
  ]);
  vi.clearAllMocks();
});
afterAll(() => db.$disconnect());

const loadArgs = () =>
  ({
    request: new Request("https://app.test/app/settings"),
    params: {},
    context: {},
  }) as LoaderFunctionArgs;
const select = (locationGid: string) =>
  action({
    ...loadArgs(),
    request: new Request("https://app.test/app/settings", {
      method: "POST",
      body: new URLSearchParams({ locationGid }),
    }),
  } as ActionFunctionArgs);

async function seedInventory(shop: string, locationGid: string) {
  return db.inventoryLevel.create({
    data: {
      shopDomain: shop,
      locationGid,
      inventoryItemGid: `gid://shopify/InventoryItem/${randomUUID()}`,
      variants: [],
      availableQuantity: 2,
      isLowStock: true,
      isCurrent: true,
      alerts: {
        create: {
          quantityAtTrigger: 2,
          thresholdAtTrigger: 5,
          notificationStatus: "SENT",
        },
      },
    },
    include: { alerts: true },
  });
}

async function seedSelection() {
  await db.shopSettings.create({
    data: {
      shopDomain,
      locationGid: locationA,
      locationName: "Warehouse 1",
      lastSyncedAt: baseline,
      lowStockThreshold: 8,
      telegramChatId: "fixture-chat",
    },
  });
  return seedInventory(shopDomain, locationA);
}

test("loader -> GraphQL service -> action -> PostgreSQL -> reload retains the choice", async () => {
  expect((await loader(loadArgs())).selected).toBeNull();
  expect((await select(locationA)).data.saved).toBe(true);
  expect((await loader(loadArgs())).selected).toEqual({
    locationGid: locationA,
    locationName: "Warehouse 1",
    lastSyncedAt: null,
    lowStockThreshold: 5,
  });
  const freshClient = new PrismaClient();
  try {
    expect(
      await freshClient.shopSettings.findUnique({ where: { shopDomain } }),
    ).toMatchObject({
      locationGid: locationA,
      locationName: "Warehouse 1",
      lastSyncedAt: null,
      lowStockThreshold: 5,
    });
  } finally {
    await freshClient.$disconnect();
  }
  expect(await db.inventoryLevel.count({ where: { shopDomain } })).toBe(0);
});

test("changing location atomically resolves only old-scope active alerts, invalidates snapshots and preserves history", async () => {
  const old = await seedSelection();
  await db.shopSettings.create({
    data: { shopDomain: otherShop, locationGid: locationA },
  });
  const other = await seedInventory(otherShop, locationA);
  const otherLocation = await seedInventory(shopDomain, locationC);
  const history = await db.inventoryAlert.create({
    data: {
      inventoryLevelId: old.id,
      quantityAtTrigger: 1,
      thresholdAtTrigger: 5,
      status: "RESOLVED",
      resolvedAt: baseline,
      notificationStatus: "FAILED",
    },
  });

  expect((await select(locationB)).data.saved).toBe(true);
  expect(
    await db.shopSettings.findUnique({ where: { shopDomain } }),
  ).toMatchObject({
    locationGid: locationB,
    lastSyncedAt: null,
    lowStockThreshold: 8,
    telegramChatId: "fixture-chat",
  });
  expect(
    await db.inventoryLevel.findUnique({ where: { id: old.id } }),
  ).toMatchObject({ isCurrent: false, availableQuantity: 2 });
  expect(
    await db.inventoryAlert.findUnique({ where: { id: old.alerts[0].id } }),
  ).toMatchObject({
    status: "RESOLVED",
    resolvedAt: expect.any(Date),
    notificationStatus: "SENT",
  });
  expect(
    await db.inventoryAlert.findUnique({ where: { id: history.id } }),
  ).toEqual(history);
  for (const untouched of [other, otherLocation]) {
    expect(
      await db.inventoryLevel.findUnique({ where: { id: untouched.id } }),
    ).toMatchObject({ isCurrent: true });
    expect(
      await db.inventoryAlert.findUnique({
        where: { id: untouched.alerts[0].id },
      }),
    ).toMatchObject({ status: "ACTIVE", resolvedAt: null });
  }
});

test("saving the same location refreshes its name without resetting the baseline or resolving alerts", async () => {
  const old = await seedSelection();
  await saveLocationSettings(shopDomain, {
    locationGid: locationA,
    locationName: "Renamed warehouse",
  });
  expect(
    await db.shopSettings.findUnique({ where: { shopDomain } }),
  ).toMatchObject({
    locationName: "Renamed warehouse",
    lastSyncedAt: baseline,
  });
  expect(
    await db.inventoryLevel.findUnique({ where: { id: old.id } }),
  ).toMatchObject({ isCurrent: true });
  expect(
    await db.inventoryAlert.findUnique({ where: { id: old.alerts[0].id } }),
  ).toMatchObject({ status: "ACTIVE" });
});

test("A -> B -> A keeps history and does not reuse A's old baseline", async () => {
  const old = await seedSelection();
  await select(locationB);
  await select(locationA);
  expect(
    await db.shopSettings.findUnique({ where: { shopDomain } }),
  ).toMatchObject({ locationGid: locationA, lastSyncedAt: null });
  expect(
    await db.inventoryLevel.findUnique({ where: { id: old.id } }),
  ).toMatchObject({ isCurrent: false });
  expect(
    await db.inventoryAlert.findUnique({ where: { id: old.alerts[0].id } }),
  ).toMatchObject({ status: "RESOLVED" });
  expect(
    await db.inventoryAlert.count({
      where: { inventoryLevel: { shopDomain } },
    }),
  ).toBe(1);
});

test("a failed final settings write rolls back alert resolutions and snapshot invalidation", async () => {
  const old = await seedSelection();
  failure.enabled = true;
  expect((await select(locationB)).init?.status).toBe(503);
  failure.enabled = false;
  expect(
    await db.shopSettings.findUnique({ where: { shopDomain } }),
  ).toMatchObject({ locationGid: locationA, lastSyncedAt: baseline });
  expect(
    await db.inventoryLevel.findUnique({ where: { id: old.id } }),
  ).toMatchObject({ isCurrent: true });
  expect(
    await db.inventoryAlert.findUnique({ where: { id: old.alerts[0].id } }),
  ).toMatchObject({ status: "ACTIVE", resolvedAt: null });
});

test("concurrent location changes serialize against the latest saved location", async () => {
  await seedSelection();
  const b = await seedInventory(shopDomain, locationB);
  const c = await seedInventory(shopDomain, locationC);
  await Promise.all([
    saveLocationSettings(shopDomain, {
      locationGid: locationB,
      locationName: "Warehouse 2",
    }),
    saveLocationSettings(shopDomain, {
      locationGid: locationC,
      locationName: "Warehouse 3",
    }),
  ]);
  const settings = await db.shopSettings.findUniqueOrThrow({
    where: { shopDomain },
  });
  const active = await db.inventoryAlert.findMany({
    where: { status: "ACTIVE", inventoryLevel: { shopDomain } },
    include: { inventoryLevel: true },
  });
  expect(active).toHaveLength(1);
  expect(active[0].inventoryLevel.locationGid).toBe(settings.locationGid);
  const intermediateId = settings.locationGid === locationB ? c.id : b.id;
  expect(
    await db.inventoryLevel.findUnique({ where: { id: intermediateId } }),
  ).toMatchObject({ isCurrent: false });
});

test("concurrent first selections create a single settings row", async () => {
  await Promise.all([
    saveLocationSettings(shopDomain, {
      locationGid: locationA,
      locationName: "Warehouse 1",
    }),
    saveLocationSettings(shopDomain, {
      locationGid: locationB,
      locationName: "Warehouse 2",
    }),
  ]);
  expect(await db.shopSettings.count({ where: { shopDomain } })).toBe(1);
});
