import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Session } from "@shopify/shopify-api";
import type { AdminGraphqlClient } from "@shopify/shopify-app-react-router/server";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
  vi,
} from "vitest";
import db from "../app/db.server";
import { unauthenticated } from "../app/shopify.server";
import { discoverLocations } from "../app/modules/inventory/location-discovery.server";
import { syncInstalledShops } from "../app/modules/inventory/inventory-background.server";
import {
  syncInventory,
  syncAllActiveLocations,
  syncInventoryForLocation,
} from "../app/modules/inventory/inventory-sync.service.server";
import { createShopifyGraphqlService } from "../app/modules/shopify/graphql/shopify-graphql.server";
import {
  commitInventorySync,
  getInventorySyncSettings,
} from "../app/modules/inventory/inventory.repository.server";
import { commitInventoryWebhook } from "../app/modules/inventory/inventory-webhook.repository.server";
import {
  saveLocationSettings,
  saveLowStockThreshold,
} from "../app/modules/settings/settings.repository.server";
import { processNotificationForShop } from "../app/modules/notifications/notification-worker.server";

const fixture = vi.hoisted(() => ({
  schema: `m2_${globalThis.crypto.randomUUID().replaceAll("-", "")}`,
  fail: false,
}));
vi.mock("../app/shopify.server", () => ({
  unauthenticated: { admin: vi.fn() },
}));
vi.mock("../app/db.server", async () => {
  const { PrismaClient } = await import("@prisma/client");
  const url = new URL(process.env.DATABASE_URL ?? "http://missing");
  if (
    !["localhost", "127.0.0.1"].includes(url.hostname) ||
    url.port !== "5433" ||
    url.pathname !== "/stocknotifier"
  )
    throw Error("M2 tests require local Compose");
  url.searchParams.set("schema", fixture.schema);
  return {
    default: new PrismaClient({ datasourceUrl: url.toString() }).$extends({
      query: {
        monitoredLocation: {
          update({ args, query }) {
            if (fixture.fail)
              throw Error("Injected location finalization failure");
            return query(args);
          },
        },
      },
    }),
  };
});
const migration = "20261102010000_multi_location_runtime";
const A = "gid://shopify/Location/1",
  B = "gid://shopify/Location/2",
  C = "gid://shopify/Location/3";
const itemGid = "gid://shopify/InventoryItem/271878346596884015";
const time = new Date("2026-11-01T00:00:00.000Z");
let workspace: string,
  shop: string,
  session: Session,
  graphql: ReturnType<typeof vi.fn<AdminGraphqlClient>>;
let active: string[], quantity: Map<string, number>, broken: string | null;
const telegram = vi.fn<typeof fetch>();
function deploy() {
  const url = new URL(process.env.DATABASE_URL!);
  url.searchParams.set("schema", fixture.schema);
  return execFileSync(
    process.execPath,
    [
      resolve("node_modules/prisma/build/index.js"),
      "migrate",
      "deploy",
      "--schema",
      join(workspace, "schema.prisma"),
    ],
    {
      env: { ...process.env, DATABASE_URL: url.toString() },
      encoding: "utf8",
      stdio: "pipe",
      timeout: 30000,
    },
  );
}
beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), "stockpulse-m2-"));
  cpSync("prisma/schema.prisma", join(workspace, "schema.prisma"));
  cpSync("prisma/migrations", join(workspace, "migrations"), {
    recursive: true,
    filter: (source) =>
      !source.includes(migration) &&
      !source.includes("20261102020000_durable_location_webhooks"),
  });
  await db.$executeRawUnsafe(`CREATE SCHEMA "${fixture.schema}"`);
  deploy();
  await db.$executeRaw`INSERT INTO "ShopSettings" ("shopDomain","locationGid","lastSyncedAt","updatedAt") VALUES ('migration-fixture.myshopify.com',${A},${time},${time})`;
  await db.$executeRaw`INSERT INTO "InventoryLevel" (id,"shopDomain","locationGid","inventoryItemGid",variants,"availableQuantity","isLowStock") VALUES ('migration-level','migration-fixture.myshopify.com',${A},${itemGid},'[]',3,true)`;
  await db.$executeRaw`INSERT INTO "InventoryAlert" (id,"inventoryLevelId","quantityAtTrigger","thresholdAtTrigger","notificationChatId","notificationText","notificationAttempts","notificationLeaseToken") VALUES ('migration-alert','migration-level',3,5,'-123','Existing text',2,'lease')`;
  cpSync(
    join("prisma/migrations", migration),
    join(workspace, "migrations", migration),
    { recursive: true },
  );
  deploy();
  cpSync(
    join("prisma/migrations", "20261102020000_durable_location_webhooks"),
    join(workspace, "migrations", "20261102020000_durable_location_webhooks"),
    { recursive: true },
  );
  deploy();
  expect(
    await db.inventoryAlert.findUnique({ where: { id: "migration-alert" } }),
  ).toMatchObject({
    origin: "INVENTORY_TRANSITION",
    status: "ACTIVE",
    notificationAttempts: 2,
    notificationLeaseToken: "lease",
    notificationText: "Existing text",
  });
}, 60000);
afterAll(async () => {
  if (!/^m2_[a-f0-9]{32}$/.test(fixture.schema)) throw Error("Unsafe cleanup");
  try {
    await db.$executeRawUnsafe(
      `DROP SCHEMA IF EXISTS "${fixture.schema}" CASCADE`,
    );
  } finally {
    await db.$disconnect();
    if (
      workspace &&
      dirname(resolve(workspace)) === resolve(tmpdir()) &&
      workspace.startsWith(join(tmpdir(), "stockpulse-m2-"))
    )
      rmSync(workspace, { recursive: true, force: true });
  }
});
beforeEach(async () => {
  fixture.fail = false;
  shop = `multi-${randomUUID()}.myshopify.com`;
  session = new Session({
    id: `offline_${shop}`,
    shop,
    state: "",
    isOnline: false,
    accessToken: "fixture",
  });
  await db.shopSettings.create({
    data: {
      shopDomain: shop,
      locationGid: A,
      locationName: "Legacy A",
      lastSyncedAt: time,
      telegramChatId: "-123",
    },
  });
  await db.session.create({
    data: {
      id: session.id,
      shop,
      state: "",
      isOnline: false,
      accessToken: "fixture",
    },
  });
  active = [A, B];
  quantity = new Map([
    [A, 3],
    [B, 8],
    [C, -1],
  ]);
  broken = null;
  graphql = vi
    .fn<AdminGraphqlClient>()
    .mockImplementation(async (query, options) => {
      if (String(query).includes("StockPulseLocations"))
        return locations(active);
      const location = String(options?.variables?.locationId);
      if (location === broken) throw Error("API page failed");
      return levels(location, quantity.get(location) ?? 8);
    });
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "fixture-only");
  telegram
    .mockReset()
    .mockResolvedValue(new Response(JSON.stringify({ ok: true })));
  vi.stubGlobal("fetch", telegram);
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  fixture.fail = false;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
function context() {
  return { session, admin: { graphql } };
}
function response(data: unknown) {
  return new Response(JSON.stringify({ data }));
}
function locations(ids: string[], more: string | null = null) {
  return response({
    locations: {
      nodes: ids.map((id) => ({ id, name: `Location ${id}`, isActive: true })),
      pageInfo: { hasNextPage: !!more, endCursor: more },
    },
  });
}
function levels(locationGid: string, q: number) {
  return response({
    location: {
      id: locationGid,
      isActive: true,
      inventoryLevels: {
        nodes: [
          {
            id: `gid://shopify/InventoryLevel/1?inventory_item_id=271878346596884015`,
            isActive: true,
            updatedAt: time.toISOString(),
            quantities: [{ name: "available", quantity: q }],
            item: {
              id: itemGid,
              sku: null,
              tracked: true,
              variants: {
                nodes: [],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    },
  });
}
async function settings(locationGid: string) {
  return {
    ...(await getInventorySyncSettings(shop, locationGid))!,
    locationGid,
  };
}
function level(locationGid: string, q: number) {
  return {
    shopDomain: shop,
    locationGid,
    inventoryItemGid: itemGid,
    inventoryLevelGid:
      "gid://shopify/InventoryLevel/1?inventory_item_id=271878346596884015",
    sku: null,
    variants: [],
    availableQuantity: q,
    shopifyUpdatedAt: time,
  };
}
async function state() {
  return {
    settings: await db.shopSettings.findUnique({ where: { shopDomain: shop } }),
    locations: await db.monitoredLocation.findMany({
      where: { shopDomain: shop },
      orderBy: { locationGid: "asc" },
    }),
    levels: await db.inventoryLevel.findMany({
      where: { shopDomain: shop },
      orderBy: { id: "asc" },
    }),
    alerts: await db.inventoryAlert.findMany({
      where: { inventoryLevel: { shopDomain: shop } },
      orderBy: { id: "asc" },
    }),
  };
}

test("discovery completes all pages, filters inactive, preserves M1 baseline and isolates shops", async () => {
  await db.monitoredLocation.create({
    data: {
      shopDomain: shop,
      locationGid: A,
      baselineCompletedAt: time,
      lastSyncedAt: time,
      syncStatus: "READY",
    },
  });
  graphql.mockResolvedValueOnce(locations([A], "next")).mockResolvedValueOnce(
    response({
      locations: {
        nodes: [
          { id: B, name: "B", isActive: true },
          { id: C, name: "C", isActive: false },
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    }),
  );
  await discoverLocations(context());
  expect(graphql.mock.calls[1][1]?.variables?.after).toBe("next");
  expect((await state()).locations).toHaveLength(2);
  expect((await settings(A)).monitored).toMatchObject({
    isActive: true,
    lastSyncedAt: time,
    baselineCompletedAt: time,
  });
  expect(
    await db.monitoredLocation.count({
      where: { shopDomain: "migration-fixture.myshopify.com" },
    }),
  ).toBe(0);
  await discoverLocations(context());
  expect((await state()).locations).toHaveLength(2);
});
test("partial discovery and duplicate locations never deactivate or partially replace stored locations", async () => {
  await discoverLocations(context());
  const before = await state();
  graphql
    .mockResolvedValueOnce(locations([C], "page2"))
    .mockRejectedValueOnce(Error("page2 failed"));
  await expect(discoverLocations(context())).rejects.toThrow();
  expect(await state()).toEqual(before);
  graphql.mockResolvedValueOnce(locations([A, A]));
  await expect(discoverLocations(context())).rejects.toThrow("duplicate");
  expect(await state()).toEqual(before);
});
test("each location commits independently with baseline alerts, zero/negative quantities and nullable SKU", async () => {
  active = [A, B, C];
  quantity.set(A, 0);
  broken = B;
  const result = await syncAllActiveLocations(context());
  expect(result.failedCount).toBe(1);
  expect(result.locations.map((r) => !!r.error)).toEqual([false, true, false]);
  let saved = await state();
  expect(saved.levels.map((row) => row.availableQuantity).sort()).toEqual([
    -1, 0,
  ]);
  expect(saved.alerts).toHaveLength(2);
  expect(
    saved.alerts.every(
      (row) =>
        row.origin === "BASELINE" &&
        row.notificationStatus === "PENDING" &&
        row.notificationNextAttemptAt === null,
    ),
  ).toBe(true);
  expect(
    saved.locations.find((row) => row.locationGid === B)?.lastSyncedAt,
  ).toBeNull();
  broken = null;
  await syncInventoryForLocation(context(), B);
  await syncAllActiveLocations(context());
  saved = await state();
  expect(saved.alerts).toHaveLength(2);
  expect(
    saved.levels.every(
      (row) => row.sku === null && Array.isArray(row.variants),
    ),
  ).toBe(true);
  expect(await processNotificationForShop(shop)).toBe(false);
  expect(telegram).not.toHaveBeenCalled();
});
test("legacy low-stock catch-up is idempotent and preserves an existing active alert and history", async () => {
  await db.monitoredLocation.create({
    data: {
      shopDomain: shop,
      locationGid: A,
      isActive: null,
      baselineCompletedAt: time,
      lastSyncedAt: time,
      syncStatus: "READY",
    },
  });
  const old = await db.inventoryLevel.create({
    data: {
      shopDomain: shop,
      locationGid: A,
      inventoryItemGid: itemGid,
      variants: [],
      availableQuantity: 3,
      isLowStock: true,
      syncedAt: time,
    },
  });
  await syncAllActiveLocations(context());
  const first = (await state()).alerts;
  expect(first).toHaveLength(1);
  expect(first[0].origin).toBe("BASELINE");
  await syncAllActiveLocations(context());
  expect((await state()).alerts).toEqual(first);
  await db.monitoredLocation.update({
    where: { shopDomain_locationGid: { shopDomain: shop, locationGid: A } },
    data: { baselineAlertsCompletedAt: null },
  });
  await syncInventoryForLocation(context(), A);
  expect((await state()).alerts).toEqual(first);
  expect((await state()).levels.find((row) => row.id === old.id)).toBeDefined();
});
test("threshold creates held alerts across locations; display selection does not resolve or invalidate them", async () => {
  quantity.set(A, 8);
  quantity.set(B, 8);
  await syncAllActiveLocations(context());
  await saveLowStockThreshold(shop, 8);
  const before = await state();
  expect(before.alerts).toHaveLength(2);
  expect(
    before.alerts.every(
      (row) =>
        row.origin === "THRESHOLD_CHANGE" &&
        row.notificationNextAttemptAt === null,
    ),
  ).toBe(true);
  await saveLocationSettings(shop, {
    locationGid: B,
    locationName: "Display B",
  });
  let after = await state();
  expect(after.levels).toEqual(before.levels);
  expect(after.alerts).toEqual(before.alerts);
  expect(after.locations).toEqual(before.locations);
  expect(await processNotificationForShop(shop)).toBe(false);
  expect(telegram).not.toHaveBeenCalled();
  await saveLowStockThreshold(shop, 2);
  after = await state();
  expect(after.alerts.every((row) => row.status === "RESOLVED")).toBe(true);
});
test("transition alerts in any monitored location keep Telegram delivery; baseline/threshold jobs cannot be claimed", async () => {
  quantity.set(A, 8);
  quantity.set(B, 8);
  await syncAllActiveLocations(context());
  quantity.set(B, 4);
  await syncInventoryForLocation(context(), B);
  expect(await processNotificationForShop(shop)).toBe(true);
  expect(telegram).toHaveBeenCalledTimes(1);
  expect((await state()).alerts[0]).toMatchObject({
    origin: "INVENTORY_TRANSITION",
    notificationStatus: "SENT",
  });
  quantity.set(A, 4);
  await db.monitoredLocation.update({
    where: { shopDomain_locationGid: { shopDomain: shop, locationGid: A } },
    data: { baselineAlertsCompletedAt: null },
  });
  await syncInventoryForLocation(context(), A);
  const held = (await state()).alerts.find((row) => row.origin === "BASELINE")!;
  // Even accidental scheduling cannot make the old worker send a digest-only origin.
  await db.inventoryAlert.update({
    where: { id: held.id },
    data: {
      notificationChatId: "-123",
      notificationText: "held",
      notificationNextAttemptAt: new Date(0),
    },
  });
  expect(await processNotificationForShop(shop)).toBe(false);
  expect(telegram).toHaveBeenCalledTimes(1);
  expect(
    await db.inventoryAlert.findUnique({ where: { id: held.id } }),
  ).toMatchObject({
    notificationStatus: "PENDING",
    notifiedAt: null,
    notificationAttempts: 0,
  });
});
test("A/B scans commit concurrently, same-location scans conflict, threshold and webhook invalidate stale reads", async () => {
  await discoverLocations(context());
  const a = await settings(A),
    b = await settings(B);
  await Promise.all([
    commitInventorySync(a, [level(A, 8)], new Date()),
    commitInventorySync(b, [level(B, 8)], new Date()),
  ]);
  const old = await settings(A);
  const results = await Promise.allSettled([
    commitInventorySync(old, [level(A, 4)], new Date()),
    commitInventorySync(old, [level(A, 3)], new Date()),
  ]);
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  const beforeThreshold = await settings(A);
  await saveLowStockThreshold(shop, 2);
  await expect(
    commitInventorySync(beforeThreshold, [level(A, 1)], new Date()),
  ).rejects.toThrow("Settings changed");
  const beforeWebhook = await settings(A);
  await commitInventoryWebhook(
    beforeWebhook,
    session.id,
    randomUUID(),
    A,
    itemGid,
    level(A, 9),
  );
  await expect(
    commitInventorySync(beforeWebhook, [level(A, 1)], new Date()),
  ).rejects.toThrow("Location changed");
});
test("stale reads, lost activity, incomplete scans and transaction failures preserve committed data", async () => {
  await syncAllActiveLocations(context());
  const saved = await state();
  await expect(
    commitInventorySync(
      await settings(A),
      [{ ...level(A, 1), shopifyUpdatedAt: new Date(0) }],
      new Date(),
    ),
  ).rejects.toThrow("Inventory changed");
  fixture.fail = true;
  await expect(
    commitInventorySync(await settings(A), [level(A, 9)], new Date()),
  ).rejects.toThrow("Injected");
  fixture.fail = false;
  expect(await state()).toEqual(saved);
  const pending = await settings(A);
  active = [B];
  await discoverLocations(context());
  await expect(
    commitInventorySync(pending, [level(A, 1)], new Date()),
  ).rejects.toThrow("Location changed");
  const inactive = await state();
  expect(inactive.levels.find((row) => row.locationGid === A)?.isCurrent).toBe(
    false,
  );
  broken = B;
  await expect(syncInventoryForLocation(context(), B)).rejects.toThrow(
    "API page",
  );
  expect(await state()).toEqual(inactive);
});
test("strict multi-location scan rejects missing available rather than treating it as zero/empty", async () => {
  await discoverLocations(context());
  const body = await levels(A, 3).json();
  body.data.location.inventoryLevels.nodes[0].quantities = [];
  graphql.mockResolvedValueOnce(response(body.data));
  await expect(syncInventoryForLocation(context(), A)).rejects.toThrow(
    "available",
  );
  expect((await state()).levels).toHaveLength(0);
});

test("final active verification can reject a scan without touching previous snapshots", async () => {
  await syncAllActiveLocations(context());
  const before = await state();
  graphql.mockImplementationOnce(async () => {
    active = [B];
    return levels(A, 1);
  });
  await expect(syncInventoryForLocation(context(), A)).rejects.toThrow(
    "no longer active",
  );
  expect(await state()).toEqual(before);
});

test("retry is scoped to a verified location and respects the API deadline during backoff", async () => {
  await discoverLocations(context());
  const result = await syncInventory(context(), B);
  expect(result.locations.map((row) => row.locationGid)).toEqual([B]);
  expect(
    (await state()).locations.find((row) => row.locationGid === A)
      ?.lastSyncedAt,
  ).toBeNull();
  await expect(syncInventory(context(), C)).rejects.toThrow(
    "not verified active",
  );
  graphql.mockResolvedValue(
    new Response(null, { status: 429, headers: { "Retry-After": "120" } }),
  );
  await expect(
    createShopifyGraphqlService(context(), {
      signal: AbortSignal.timeout(20),
    }).getLocations(),
  ).rejects.toThrow();
  expect(
    graphql.mock.calls.filter(([, options]) => options?.signal).length,
  ).toBeGreaterThan(0);
});

test("Shopify reauthentication responses propagate through orchestration", async () => {
  graphql.mockImplementation(async (query) => {
    if (String(query).includes("StockPulseLocations")) return locations([A]);
    throw new Response(null, { status: 401 });
  });
  await expect(syncAllActiveLocations(context())).rejects.toMatchObject({
    status: 401,
  });
  expect((await state()).levels).toHaveLength(0);
});
test("background uses official offline context and resumes from persisted per-location successes after restart", async () => {
  // Other fixture shops are deliberately denied credentials by the mock.
  vi.mocked(unauthenticated.admin).mockImplementation(async (domain) => {
    if (domain !== shop) throw Error("no fixture auth");
    return context() as Awaited<ReturnType<typeof unauthenticated.admin>>;
  });
  broken = B;
  await syncInstalledShops();
  expect(
    (await state()).locations.find((row) => row.locationGid === A)?.syncStatus,
  ).toBe("READY");
  const completed = (await state()).locations.find(
    (row) => row.locationGid === A,
  )!.lastSyncedAt;
  broken = null;
  await syncInstalledShops();
  expect(
    (await state()).locations.find((row) => row.locationGid === A)
      ?.lastSyncedAt,
  ).toEqual(completed);
  expect(
    (await state()).locations.find((row) => row.locationGid === B)?.syncStatus,
  ).toBe("READY");
  expect(unauthenticated.admin).toHaveBeenCalledWith(shop);
});
