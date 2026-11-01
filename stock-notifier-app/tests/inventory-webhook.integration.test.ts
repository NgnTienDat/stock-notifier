import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Session } from "@shopify/shopify-api";
import type { AdminGraphqlClient } from "@shopify/shopify-app-react-router/server";
import type { ActionFunctionArgs } from "react-router";
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
import { authenticate, unauthenticated } from "../app/shopify.server";
import { action } from "../app/routes/webhooks.inventory";
import {
  claimWebhookJob,
  retryWebhookJob,
  workerMilliseconds,
} from "../app/modules/inventory/webhook-job.repository.server";
import {
  processNextWebhook,
  processWebhookJob,
} from "../app/modules/inventory/webhook-job.service.server";
import {
  getInventorySyncSettings,
  commitInventorySync,
} from "../app/modules/inventory/inventory.repository.server";
import { discoverLocations } from "../app/modules/inventory/location-discovery.server";
import { syncAllActiveLocations } from "../app/modules/inventory/inventory-sync.service.server";
import { saveLowStockThreshold } from "../app/modules/settings/settings.repository.server";
import { processNotificationForShop } from "../app/modules/notifications/notification-worker.server";

const fixture = vi.hoisted(() => ({
  schema: `m3_${globalThis.crypto.randomUUID().replaceAll("-", "")}`,
  fail: false,
}));
vi.mock("../app/shopify.server", () => ({
  authenticate: { webhook: vi.fn() },
  unauthenticated: { admin: vi.fn() },
}));
vi.mock("../app/db.server", async () => {
  const { PrismaClient } = await import("@prisma/client");
  const url = new URL(process.env.DATABASE_URL ?? "http://missing");
  if (
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    url.port !== "5433" ||
    url.pathname !== "/stocknotifier"
  )
    throw Error("M3 tests require local Compose");
  url.searchParams.set("schema", fixture.schema);
  return { default: new PrismaClient({ datasourceUrl: url.toString() }) };
});
vi.mock(
  "../app/modules/inventory/webhook-job.repository.server",
  async (original) => {
    const actual =
      await original<
        typeof import("../app/modules/inventory/webhook-job.repository.server")
      >();
    return {
      ...actual,
      completeWebhookJob: vi.fn(
        async (...args: Parameters<typeof actual.completeWebhookJob>) => {
          if (fixture.fail) throw Error("Injected processed write failure");
          return actual.completeWebhookJob(...args);
        },
      ),
    };
  },
);
const migration = "20261102020000_durable_location_webhooks";
const A = "gid://shopify/Location/1",
  B = "gid://shopify/Location/2",
  C = "gid://shopify/Location/3";
const item = "gid://shopify/InventoryItem/271878346596884015";
const at = new Date("2026-11-01T00:00:00Z");
let temp: string,
  shop: string,
  session: Session,
  graphql: ReturnType<typeof vi.fn<AdminGraphqlClient>>;
let metadata: Map<
  string,
  { locationGid: string; locationName: string; isActive: boolean }
>;
let quantities: Map<string, number>, connected: Set<string>;
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
      join(temp, "schema.prisma"),
    ],
    {
      env: { ...process.env, DATABASE_URL: url.toString() },
      encoding: "utf8",
      stdio: "pipe",
      timeout: 30000,
    },
  );
}
async function oldRows() {
  return db.$queryRaw`SELECT to_jsonb(a)-'resolutionReason' AS row FROM "InventoryAlert" a WHERE id='old-alert'`;
}
beforeAll(async () => {
  temp = mkdtempSync(join(tmpdir(), "stockpulse-m3-"));
  cpSync("prisma/schema.prisma", join(temp, "schema.prisma"));
  cpSync("prisma/migrations", join(temp, "migrations"), {
    recursive: true,
    filter: (source) => !source.includes(migration),
  });
  await db.$executeRawUnsafe(`CREATE SCHEMA "${fixture.schema}"`);
  deploy();
  await db.$executeRaw`INSERT INTO "ShopSettings" ("shopDomain","updatedAt") VALUES ('migration-fixture.myshopify.com',${at})`;
  await db.$executeRaw`INSERT INTO "Session"(id,shop,state,"isOnline","accessToken") VALUES ('old-session','migration-fixture.myshopify.com','fixture',false,'fixture-only')`;
  await db.$executeRaw`INSERT INTO "InventoryLevel"(id,"shopDomain","locationGid","inventoryItemGid",variants,"availableQuantity","isLowStock") VALUES ('old-level','migration-fixture.myshopify.com',${A},${item},'[]',3,true)`;
  await db.$executeRaw`INSERT INTO "InventoryAlert"(id,"inventoryLevelId","quantityAtTrigger","thresholdAtTrigger","notificationChatId","notificationText","notificationAttempts","notificationLeaseToken","notificationNextAttemptAt") VALUES ('old-alert','old-level',3,5,'-123','existing',2,'existing-lease',${at})`;
  await db.$executeRaw`INSERT INTO "WebhookEvent"(id,"shopDomain","webhookId","processedAt") VALUES ('old-event','migration-fixture.myshopify.com','old-delivery',${at})`;
  const before = await oldRows();
  const indexes =
    await db.$queryRaw`SELECT indexname,indexdef FROM pg_indexes WHERE schemaname=${fixture.schema} ORDER BY indexname`;
  cpSync(
    join("prisma/migrations", migration),
    join(temp, "migrations", migration),
    { recursive: true },
  );
  deploy();
  expect(await oldRows()).toEqual(before);
  expect(
    await db.session.findUnique({ where: { id: "old-session" } }),
  ).toMatchObject({ accessToken: "fixture-only" });
  expect(
    await db.webhookEvent.findUnique({ where: { id: "old-event" } }),
  ).toMatchObject({
    processedAt: at,
    nextAttemptAt: null,
    topic: null,
    attempts: 0,
  });
  const after = await db.$queryRaw<
    unknown[]
  >`SELECT indexname,indexdef FROM pg_indexes WHERE schemaname=${fixture.schema} ORDER BY indexname`;
  expect(after).toEqual(expect.arrayContaining(indexes as unknown[]));
}, 60000);
afterAll(async () => {
  if (!/^m3_[a-f0-9]{32}$/.test(fixture.schema)) throw Error("Unsafe cleanup");
  try {
    await db.$executeRawUnsafe(
      `DROP SCHEMA IF EXISTS "${fixture.schema}" CASCADE`,
    );
  } finally {
    await db.$disconnect();
    if (
      temp &&
      dirname(resolve(temp)) === resolve(tmpdir()) &&
      temp.startsWith(join(tmpdir(), "stockpulse-m3-"))
    )
      rmSync(temp, { recursive: true, force: true });
  }
});
beforeEach(async () => {
  fixture.fail = false;
  shop = `webhook-${randomUUID()}.myshopify.com`;
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
      locationGid: null,
      lastSyncedAt: null,
      locationsDiscoveredAt: at,
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
  metadata = new Map(
    [A, B].map((locationGid) => [
      locationGid,
      { locationGid, locationName: locationGid, isActive: true },
    ]),
  );
  quantities = new Map([
    [A, 8],
    [B, 8],
    [C, 3],
  ]);
  connected = new Set([A, B, C]);
  for (const locationGid of [A, B]) {
    await db.monitoredLocation.create({
      data: {
        shopDomain: shop,
        locationGid,
        locationName: locationGid,
        isActive: true,
        syncStatus: "READY",
        baselineCompletedAt: at,
        baselineAlertsCompletedAt: at,
        lastSyncedAt: at,
      },
    });
    await db.inventoryLevel.create({
      data: {
        shopDomain: shop,
        locationGid,
        inventoryItemGid: item,
        variants: [],
        sku: null,
        availableQuantity: 8,
        isLowStock: false,
        shopifyUpdatedAt: at,
        syncedAt: at,
      },
    });
  }
  graphql = vi
    .fn<AdminGraphqlClient>()
    .mockImplementation(async (query, options) => {
      const text = String(query),
        locationGid = String(options?.variables?.locationId);
      if (text.includes("StockPulseLocations"))
        return response({
          locations: {
            nodes: [...metadata.values()]
              .filter((row) => row.isActive)
              .map((row) => ({
                id: row.locationGid,
                name: row.locationName,
                isActive: true,
              })),
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        });
      const location = metadata.get(locationGid);
      if (text.includes("query StockPulseLocation("))
        return response({
          location: location
            ? {
                id: locationGid,
                name: location.locationName,
                isActive: location.isActive,
              }
            : null,
        });
      if (text.includes("StockPulseLocationInventory"))
        return response({
          location: location
            ? {
                id: locationGid,
                isActive: location.isActive,
                inventoryLevels: {
                  nodes: connected.has(locationGid)
                    ? [{ ...remoteLevel(locationGid), item: remoteItem() }]
                    : [],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              }
            : null,
        });
      return response({
        location: location
          ? { id: locationGid, isActive: location.isActive }
          : null,
        inventoryItem: {
          ...remoteItem(),
          inventoryLevel: connected.has(locationGid)
            ? remoteLevel(locationGid)
            : null,
        },
      });
    });
  vi.mocked(unauthenticated.admin).mockResolvedValue(
    context() as Awaited<ReturnType<typeof unauthenticated.admin>>,
  );
  vi.mocked(authenticate.webhook).mockImplementation(
    async (request) =>
      ({
        shop,
        topic: request.headers.get("X-Shopify-Topic"),
        webhookId: request.headers.get("X-Shopify-Webhook-Id"),
        payload: await request.json(),
      }) as Awaited<ReturnType<typeof authenticate.webhook>>,
  );
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "fixture-token");
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
function remoteItem() {
  return {
    id: item,
    sku: null,
    tracked: true,
    variants: {
      nodes: [],
      pageInfo: { hasNextPage: false, endCursor: null as string | null },
    },
  };
}
function remoteLevel(locationGid: string) {
  return {
    id: "gid://shopify/InventoryLevel/1?inventory_item_id=271878346596884015",
    isActive: true,
    updatedAt: "2026-11-01T01:00:00Z",
    quantities: [
      { name: "available", quantity: quantities.get(locationGid) ?? 8 },
    ],
  };
}
async function deliver(
  topic = "INVENTORY_LEVELS_UPDATE",
  locationGid = A,
  id = randomUUID(),
  eventId = "same-event",
) {
  const payload = topic.startsWith("LOCATIONS_")
    ? { id: locationGid.split("/").at(-1) }
    : {
        location_id: locationGid.split("/").at(-1),
        inventory_item_id: item.split("/").at(-1),
        available: 999,
        updated_at: "2000-01-01T00:00:00Z",
      };
  const result = await action({
    request: new Request(
      "https://app.test/webhooks/inventory?shop=attacker.myshopify.com",
      {
        method: "POST",
        headers: {
          "X-Shopify-Topic": topic,
          "X-Shopify-Webhook-Id": id,
          "X-Shopify-Event-Id": eventId,
        },
        body: JSON.stringify(payload),
      },
    ),
  } as ActionFunctionArgs);
  return { response: result, id };
}
async function work() {
  expect(await processNextWebhook(shop)).toBe(true);
}
async function job(id: string) {
  return db.webhookEvent.findUniqueOrThrow({
    where: { shopDomain_webhookId: { shopDomain: shop, webhookId: id } },
  });
}
async function due(id: string) {
  await db.webhookEvent.update({
    where: { shopDomain_webhookId: { shopDomain: shop, webhookId: id } },
    data: { nextAttemptAt: new Date(0) },
  });
}
async function state() {
  return {
    locations: await db.monitoredLocation.findMany({
      where: { shopDomain: shop },
      orderBy: { locationGid: "asc" },
    }),
    levels: await db.inventoryLevel.findMany({
      where: { shopDomain: shop },
      orderBy: { locationGid: "asc" },
    }),
    alerts: await db.inventoryAlert.findMany({
      where: { inventoryLevel: { shopDomain: shop } },
      orderBy: { id: "asc" },
    }),
  };
}
async function captured(locationGid: string) {
  return {
    ...(await getInventorySyncSettings(shop, locationGid))!,
    locationGid,
  };
}
function level(locationGid: string, quantity: number) {
  return {
    shopDomain: shop,
    locationGid,
    inventoryItemGid: item,
    inventoryLevelGid: remoteLevel(locationGid).id,
    sku: null,
    variants: [],
    availableQuantity: quantity,
    shopifyUpdatedAt: at,
  };
}

test("receipt only persists a durable job, acknowledges missing HTTP session, and deduplicates delivery not event ID", async () => {
  const id = randomUUID();
  const results = await Promise.all([
    deliver("INVENTORY_LEVELS_UPDATE", A, id),
    deliver("INVENTORY_LEVELS_UPDATE", A, id),
  ]);
  expect(results.map((row) => row.response.status)).toEqual([200, 200]);
  expect(graphql).not.toHaveBeenCalled();
  expect(telegram).not.toHaveBeenCalled();
  expect(await job(id)).toMatchObject({
    processedAt: null,
    attempts: 0,
    topic: "INVENTORY_LEVELS_UPDATE",
    eventId: "same-event",
  });
  await deliver("INVENTORY_LEVELS_CONNECT", A);
  await deliver("INVENTORY_LEVELS_UPDATE", B);
  expect(
    await db.webhookEvent.count({
      where: { shopDomain: shop, eventId: "same-event" },
    }),
  ).toBe(3);
});

test.each([A, B])(
  "update at %s is isolated despite same item, legacy selection null and stale payload quantity",
  async (location) => {
    quantities.set(location, 4);
    const before = await state();
    const { id } = await deliver("INVENTORY_LEVELS_UPDATE", location);
    await work();
    const saved = await state();
    expect(
      saved.levels.find((row) => row.locationGid === location),
    ).toMatchObject({ availableQuantity: 4, isLowStock: true });
    expect(saved.levels.find((row) => row.locationGid !== location)).toEqual(
      before.levels.find((row) => row.locationGid !== location),
    );
    expect(saved.alerts).toHaveLength(1);
    expect(saved.alerts[0]).toMatchObject({
      origin: "INVENTORY_TRANSITION",
      quantityAtTrigger: 4,
    });
    expect((await job(id)).processedAt).toBeInstanceOf(Date);
    expect(
      saved.locations.every(
        (row) => row.lastSyncedAt?.getTime() === at.getTime(),
      ),
    ).toBe(true);
  },
);

test("all transitions, zero/negative quantities and duplicate redelivery preserve alert history and Telegram eligibility", async () => {
  for (const q of [5, 0, -2, 8, 4]) {
    quantities.set(B, q);
    const { id } = await deliver("INVENTORY_LEVELS_UPDATE", B);
    await work();
    await deliver("INVENTORY_LEVELS_UPDATE", B, id);
  }
  const saved = await state();
  expect(saved.alerts).toHaveLength(2);
  expect(saved.alerts.filter((row) => row.status === "ACTIVE")).toHaveLength(1);
  expect(
    saved.alerts.find((row) => row.status === "RESOLVED")?.resolutionReason,
  ).toBe("STOCK_RECOVERED");
  expect(await processNotificationForShop(shop)).toBe(true);
  expect(telegram).toHaveBeenCalledTimes(1);
});

test("two same-location jobs serialize, retry a conflicting reread and never duplicate ACTIVE or notification jobs", async () => {
  quantities.set(A, 4);
  await deliver();
  await deliver();
  let release!: () => void;
  let count = 0;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const original = graphql.getMockImplementation()!;
  graphql.mockImplementation(async (...args) => {
    if (String(args[0]).includes("StockPulseInventoryLevel")) {
      if (++count === 2) release();
      await gate;
    }
    return original(...args);
  });
  await Promise.all([processNextWebhook(shop), processNextWebhook(shop)]);
  const rows = await db.webhookEvent.findMany({ where: { shopDomain: shop } });
  expect(rows.filter((row) => row.processedAt)).toHaveLength(1);
  expect(
    rows.filter((row) => !row.processedAt && row.nextAttemptAt),
  ).toHaveLength(1);
  graphql.mockImplementation(original);
  for (const row of rows.filter((row) => !row.processedAt))
    await due(row.webhookId);
  await work();
  expect((await state()).alerts).toHaveLength(1);
  expect(
    (await state()).alerts.filter((row) => row.notificationNextAttemptAt),
  ).toHaveLength(1);
});

test("different-location jobs commit concurrently without cross-location interference", async () => {
  quantities.set(A, 4);
  quantities.set(B, 0);
  await deliver("INVENTORY_LEVELS_UPDATE", A);
  await deliver("INVENTORY_LEVELS_UPDATE", B);
  await Promise.all([processNextWebhook(shop), processNextWebhook(shop)]);
  expect((await state()).alerts).toHaveLength(2);
  expect(
    await db.webhookEvent.count({
      where: { shopDomain: shop, processedAt: { not: null } },
    }),
  ).toBe(2);
});

test("disconnect only invalidates its item; delayed disconnect after reconnect rereads current state", async () => {
  quantities.set(A, 4);
  await deliver();
  await work();
  connected.delete(A);
  await deliver("INVENTORY_LEVELS_DISCONNECT", A);
  await work();
  expect(
    (await state()).levels.find((row) => row.locationGid === A)?.isCurrent,
  ).toBe(false);
  expect(
    (await state()).levels.find((row) => row.locationGid === B)?.isCurrent,
  ).toBe(true);
  expect((await state()).alerts[0].resolutionReason).toBe(
    "INVENTORY_UNAVAILABLE",
  );
  connected.add(A);
  await deliver("INVENTORY_LEVELS_CONNECT", A);
  await work();
  await deliver("INVENTORY_LEVELS_DISCONNECT", A);
  await work();
  expect(
    (await state()).levels.find((row) => row.locationGid === A)?.isCurrent,
  ).toBe(true);
  expect(
    (await state()).alerts.filter((row) => row.status === "ACTIVE"),
  ).toMatchObject([{ origin: "BASELINE", notificationNextAttemptAt: null }]);
});

test("older API timestamps do not overwrite newer snapshots", async () => {
  await db.inventoryLevel.updateMany({
    where: { shopDomain: shop, locationGid: A },
    data: {
      shopifyUpdatedAt: new Date("2026-11-02T00:00:00Z"),
      availableQuantity: 12,
    },
  });
  quantities.set(A, 1);
  const { id } = await deliver();
  await work();
  expect(
    (await state()).levels.find((row) => row.locationGid === A)
      ?.availableQuantity,
  ).toBe(12);
  expect((await job(id)).result).toBe("stale_read");
});

test("GraphQL error and final processed-write failure retain inventory/alerts and durable retry", async () => {
  quantities.set(A, 3);
  const before = await state();
  const { id } = await deliver();
  graphql.mockRejectedValueOnce(Error("API incomplete"));
  await work();
  expect(await state()).toEqual(before);
  expect(await job(id)).toMatchObject({
    processedAt: null,
    result: "retry_pending",
  });
  await due(id);
  fixture.fail = true;
  await work();
  fixture.fail = false;
  expect(await state()).toEqual(before);
  expect((await job(id)).processedAt).toBeNull();
  await due(id);
  await work();
  expect((await state()).alerts).toHaveLength(1);
  expect((await job(id)).processedAt).toBeInstanceOf(Date);
});

test("create active location queues baseline without Telegram; rename preserves baseline, alerts and quantities", async () => {
  metadata.set(C, { locationGid: C, locationName: "New C", isActive: true });
  await deliver("LOCATIONS_CREATE", C);
  await work();
  const before = await state();
  const created = before.locations.find((row) => row.locationGid === C)!;
  expect(created.syncStatus).toBe("READY");
  expect(before.alerts[0]).toMatchObject({
    origin: "BASELINE",
    notificationStatus: "PENDING",
    notificationNextAttemptAt: null,
  });
  metadata.set(C, {
    locationGid: C,
    locationName: "Renamed C",
    isActive: true,
  });
  await deliver("LOCATIONS_UPDATE", C);
  await work();
  const after = await state();
  expect(after.locations.find((row) => row.locationGid === C)).toMatchObject({
    locationName: "Renamed C",
    baselineCompletedAt: created.baselineCompletedAt,
    lastSyncedAt: created.lastSyncedAt,
  });
  expect(after.levels).toEqual(before.levels);
  expect(after.alerts).toEqual(before.alerts);
  expect(await processNotificationForShop(shop)).toBe(false);
  expect(telegram).not.toHaveBeenCalled();
});

test.each(["quantity", "activity", "variants"])(
  "incomplete %s read leaves inventory intact and job retryable",
  async (missing) => {
    quantities.set(A, 3);
    const before = await state();
    const { id } = await deliver();
    const level = remoteLevel(A);
    const remote = remoteItem();
    if (missing === "quantity") level.quantities = [];
    if (missing === "activity") Reflect.deleteProperty(level, "isActive");
    if (missing === "variants") {
      remote.variants.pageInfo = { hasNextPage: true, endCursor: "more" };
    }
    graphql.mockResolvedValueOnce(
      response({
        location: { id: A, isActive: true },
        inventoryItem: { ...remote, inventoryLevel: level },
      }),
    );
    if (missing === "variants")
      graphql.mockRejectedValueOnce(Error("Last variant page failed"));
    await work();
    expect(await state()).toEqual(before);
    expect(await job(id)).toMatchObject({
      processedAt: null,
      result: "retry_pending",
    });
  },
);

test("failed lifecycle lookup preserves active locations and retries", async () => {
  const before = await state();
  const { id } = await deliver("LOCATIONS_DEACTIVATE", A);
  graphql.mockResolvedValueOnce(response({}));
  await work();
  expect(await state()).toEqual(before);
  expect(await job(id)).toMatchObject({
    processedAt: null,
    result: "retry_pending",
  });
});

test("deactivate fences in-flight scans, resolves only that location with the correct reason", async () => {
  quantities.set(B, 3);
  await deliver("INVENTORY_LEVELS_UPDATE", B);
  await work();
  const pending = await captured(B),
    other = (await state()).levels.find((row) => row.locationGid === A);
  metadata.get(B)!.isActive = false;
  await deliver("LOCATIONS_DEACTIVATE", B);
  await work();
  await expect(
    commitInventorySync(pending, [level(B, 8)], new Date()),
  ).rejects.toThrow();
  const saved = await state();
  expect(saved.levels.find((row) => row.locationGid === B)?.isCurrent).toBe(
    false,
  );
  expect(saved.alerts[0]).toMatchObject({
    status: "RESOLVED",
    resolutionReason: "LOCATION_DEACTIVATED",
  });
  expect(saved.levels.find((row) => row.locationGid === A)).toEqual(other);
});

test("reactivation starts a fresh baseline; jobs held from the previous generation cannot create new transitions", async () => {
  const old = await deliver("INVENTORY_LEVELS_UPDATE", B);
  const claim = (await claimWebhookJob(shop))!;
  metadata.get(B)!.isActive = false;
  await deliver("LOCATIONS_DEACTIVATE", B);
  await work();
  metadata.get(B)!.isActive = true;
  quantities.set(B, 2);
  await deliver("LOCATIONS_ACTIVATE", B);
  await work();
  const saved = await state();
  expect(saved.locations.find((row) => row.locationGid === B)).toMatchObject({
    isActive: true,
    syncStatus: "READY",
    generation: 2n,
  });
  expect(saved.alerts).toHaveLength(1);
  expect(saved.alerts[0].origin).toBe("BASELINE");
  await processWebhookJob(claim);
  expect((await job(old.id)).result).toBe("stale_cycle");
  expect((await state()).alerts).toEqual(saved.alerts);
});

test("deactivation during a webhook API read fences its late inventory commit", async () => {
  quantities.set(A, 3);
  const old = await deliver();
  const claim = (await claimWebhookJob(shop))!;
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => (entered = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  const original = graphql.getMockImplementation()!;
  graphql.mockImplementationOnce(async (...args) => {
    const result = await original(...args);
    entered();
    await gate;
    return result;
  });
  const late = expect(processWebhookJob(claim)).rejects.toThrow("changed");
  await ready;
  metadata.get(A)!.isActive = false;
  await deliver("LOCATIONS_DEACTIVATE", A);
  await work();
  const before = await state();
  release();
  await late;
  expect(await state()).toEqual(before);
  expect((await job(old.id)).processedAt).toBeNull();
});

test("delete is durable without GraphQL, and stale discovery or activation cannot resurrect a tombstone", async () => {
  quantities.set(B, 3);
  await deliver("INVENTORY_LEVELS_UPDATE", B);
  await work();
  const pending = await captured(B);
  await deliver("LOCATIONS_DELETE", B);
  expect(
    (await state()).locations.find((row) => row.locationGid === B)?.deletedAt,
  ).toBeInstanceOf(Date);
  graphql.mockClear();
  await work();
  expect(graphql).not.toHaveBeenCalled();
  await expect(
    commitInventorySync(pending, [level(B, 8)], new Date()),
  ).rejects.toThrow();
  expect((await state()).alerts[0].resolutionReason).toBe("LOCATION_DELETED");
  await discoverLocations(context());
  await deliver("LOCATIONS_ACTIVATE", B);
  await work();
  expect(
    (await state()).locations.find((row) => row.locationGid === B)?.isActive,
  ).toBe(false);
});

test("inventory received before a new location baseline is not dropped and creates only a held baseline alert", async () => {
  metadata.set(C, { locationGid: C, locationName: "C", isActive: true });
  const { id } = await deliver("INVENTORY_LEVELS_UPDATE", C);
  await work();
  expect((await job(id)).processedAt).toBeInstanceOf(Date);
  expect(
    (await state()).locations.find((row) => row.locationGid === C)?.syncStatus,
  ).toBe("READY");
  expect((await state()).alerts[0]).toMatchObject({
    origin: "BASELINE",
    notificationNextAttemptAt: null,
  });
});

test.each([true, false])(
  "reconciliation cleans a deleted tombstone even if its job exhausted; API contains deleted ID: %s",
  async (visible) => {
    quantities.set(B, 3);
    await deliver("INVENTORY_LEVELS_UPDATE", B);
    await work();
    const { id } = await deliver("LOCATIONS_DELETE", B);
    await db.webhookEvent.update({
      where: { shopDomain_webhookId: { shopDomain: shop, webhookId: id } },
      data: { attempts: 8, nextAttemptAt: null, result: "retry_exhausted" },
    });
    if (!visible) metadata.delete(B);
    await discoverLocations(context());
    const saved = await state();
    expect(saved.levels.find((row) => row.locationGid === B)?.isCurrent).toBe(
      false,
    );
    expect(saved.alerts[0]).toMatchObject({
      status: "RESOLVED",
      resolutionReason: "LOCATION_DELETED",
    });
    expect(saved.locations.find((row) => row.locationGid === B)?.isActive).toBe(
      false,
    );
    expect((await job(id)).processedAt).toBeNull();
  },
);

test("missing offline session remains pending; restart reclaims an expired lease and fences the stale worker", async () => {
  const { id } = await deliver();
  vi.mocked(unauthenticated.admin).mockRejectedValueOnce(
    Error("offline missing"),
  );
  await work();
  expect((await job(id)).processedAt).toBeNull();
  await due(id);
  const old = (await claimWebhookJob(shop))!;
  await db.webhookEvent.update({
    where: { id: old.id },
    data: { leaseUntil: new Date(0) },
  });
  const owner = (await claimWebhookJob(shop))!;
  expect(owner.leaseToken).not.toBe(old.leaseToken);
  quantities.set(A, 4);
  const before = await state();
  await expect(processWebhookJob(old)).rejects.toThrow("lease lost");
  expect(await state()).toEqual(before);
  await processWebhookJob(owner);
  expect((await job(id)).processedAt).toBeInstanceOf(Date);
});

test("retry exhaustion remains visibly unprocessed instead of recording false success", async () => {
  const { id } = await deliver();
  await db.webhookEvent.update({
    where: { shopDomain_webhookId: { shopDomain: shop, webhookId: id } },
    data: { attempts: 7 },
  });
  const claim = (await claimWebhookJob(shop))!;
  await retryWebhookJob(claim);
  expect(await job(id)).toMatchObject({
    processedAt: null,
    nextAttemptAt: null,
    result: "retry_exhausted",
    attempts: 8,
  });
  expect(await claimWebhookJob(shop)).toBeNull();
  expect(workerMilliseconds("UNSET_M3_CONFIG", 60000)).toBe(60000);
});

test("reconciliation recovers missed inventory/lifecycle events and partial discovery never deactivates stored locations", async () => {
  quantities.set(A, 4);
  metadata.set(C, {
    locationGid: C,
    locationName: "Recovered C",
    isActive: true,
  });
  await syncAllActiveLocations(context());
  expect((await state()).alerts).toHaveLength(2);
  const before = await state();
  graphql
    .mockResolvedValueOnce(
      response({
        locations: {
          nodes: [],
          pageInfo: { hasNextPage: true, endCursor: "next" },
        },
      }),
    )
    .mockRejectedValueOnce(Error("last page failed"));
  await expect(discoverLocations(context())).rejects.toThrow();
  expect(await state()).toEqual(before);
  await syncAllActiveLocations(context());
  expect((await state()).alerts).toHaveLength(2);
});

test("tenant isolation keeps identical delivery/resource identifiers separate", async () => {
  const id = randomUUID(),
    foreign = `foreign-${randomUUID()}.myshopify.com`;
  await db.shopSettings.create({ data: { shopDomain: foreign } });
  await db.webhookEvent.create({
    data: { shopDomain: foreign, webhookId: id, processedAt: at },
  });
  quantities.set(A, 4);
  await deliver("INVENTORY_LEVELS_UPDATE", A, id);
  await work();
  expect((await state()).alerts).toHaveLength(1);
  expect(
    await db.webhookEvent.findUnique({
      where: { shopDomain_webhookId: { shopDomain: foreign, webhookId: id } },
    }),
  ).toMatchObject({ processedAt: at, attempts: 0 });
});

test("threshold and baseline origins remain excluded from individual Telegram sends", async () => {
  await saveLowStockThreshold(shop, 9);
  const alerts = (await state()).alerts;
  expect(alerts).toHaveLength(2);
  expect(alerts.every((row) => row.origin === "THRESHOLD_CHANGE")).toBe(true);
  expect(await processNotificationForShop(shop)).toBe(false);
  expect(telegram).not.toHaveBeenCalled();
});
