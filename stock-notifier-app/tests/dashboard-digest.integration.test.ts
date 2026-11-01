import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
  vi,
} from "vitest";
import { Session } from "@shopify/shopify-api";
import type { LoaderFunctionArgs } from "react-router";
import { createMemoryRouter, RouterProvider } from "react-router";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import db from "../app/db.server";
import { authenticate } from "../app/shopify.server";
import Dashboard, { loader as dashboardLoader } from "../app/routes/app._index";
import AlertHistory, {
  loader as historyLoader,
} from "../app/routes/app.alerts";
import Settings from "../app/routes/app.settings";
import {
  EmptyState,
  DashboardErrorBoundary,
} from "../app/modules/dashboard/components";
import {
  getDashboard,
  getAlertHistory,
} from "../app/modules/dashboard/dashboard.repository.server";
import { parseDashboardFilters } from "../app/modules/dashboard/filters";
import {
  commitInventorySync,
  getInventorySyncSettings,
} from "../app/modules/inventory/inventory.repository.server";
import {
  saveLowStockThreshold,
  saveTelegramChatId,
} from "../app/modules/settings/settings.repository.server";
import { processDigestForShop } from "../app/modules/notifications/digest.server";
import {
  claimDigest,
  readDigest,
  finishDigest,
} from "../app/modules/notifications/digest.repository.server";
import { formatDigest } from "../app/modules/notifications/digest-format";
import { processNotificationForShop } from "../app/modules/notifications/notification-worker.server";

const fixture = vi.hoisted(() => ({
  schema: `m4_${globalThis.crypto.randomUUID().replaceAll("-", "")}`,
  fail: false,
  failSync: false,
}));
vi.mock("../app/db.server", async () => {
  const { PrismaClient } = await import("@prisma/client");
  const url = new URL(process.env.DATABASE_URL ?? "http://missing");
  if (
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    url.port !== "5433" ||
    url.pathname !== "/stocknotifier"
  )
    throw Error("M4 tests require local Compose");
  url.searchParams.set("schema", fixture.schema);
  return {
    default: new PrismaClient({ datasourceUrl: url.toString() }).$extends({
      query: {
        monitoredLocation: {
          update({ args, query }) {
            if (fixture.failSync) throw Error("Injected sync rollback");
            return query(args);
          },
        },
        inventoryAlert: {
          updateMany({ args, query }) {
            if (fixture.fail && args.data.notificationStatus === "SENT")
              throw Error("Injected finalization failure");
            return query(args);
          },
        },
      },
    }),
  };
});
vi.mock("../app/shopify.server", () => ({ authenticate: { admin: vi.fn() } }));
const migration = "20261102030000_dashboard_digests";
const A = "gid://shopify/Location/1",
  B = "gid://shopify/Location/2",
  C = "gid://shopify/Location/3";
const item = "gid://shopify/InventoryItem/1";
let temp: string, shop: string;
const telegram = vi.fn<typeof fetch>();
function deploy() {
  const url = new URL(process.env.DATABASE_URL!);
  url.searchParams.set("schema", fixture.schema);
  execFileSync(
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
async function fingerprints() {
  const rows: unknown[] = [];
  for (const table of [
    "Session",
    "ShopSettings",
    "InventoryLevel",
    "InventoryAlert",
    "MonitoredLocation",
    "WebhookEvent",
  ]) {
    const remove =
      table === "InventoryAlert"
        ? "-'digestId'"
        : table === "MonitoredLocation"
          ? "-'lastSyncAttemptAt'-'lastSyncError'"
          : "";
    rows.push(
      await db.$queryRawUnsafe(
        `SELECT md5(COALESCE(string_agg((to_jsonb(t)${remove})::text,',' ORDER BY (to_jsonb(t)${remove})::text),'')) AS hash FROM "${table}" t`,
      ),
    );
  }
  return rows;
}
beforeAll(async () => {
  temp = mkdtempSync(join(tmpdir(), "stockpulse-m4-"));
  cpSync("prisma/schema.prisma", join(temp, "schema.prisma"));
  cpSync("prisma/migrations", join(temp, "migrations"), {
    recursive: true,
    filter: (path) => !path.includes(migration),
  });
  await db.$executeRawUnsafe(`CREATE SCHEMA "${fixture.schema}"`);
  deploy();
  await db.$executeRaw`INSERT INTO "ShopSettings"("shopDomain","telegramChatId","updatedAt") VALUES ('legacy.myshopify.com','-123',NOW())`;
  await db.$executeRaw`INSERT INTO "Session"(id,shop,state,"accessToken") VALUES ('legacy-session','legacy.myshopify.com','','fixture')`;
  await db.$executeRaw`INSERT INTO "InventoryLevel"(id,"shopDomain","locationGid","inventoryItemGid",variants,"availableQuantity","isLowStock") VALUES ('legacy-level','legacy.myshopify.com',${A},${item},'[]',3,true)`;
  await db.$executeRaw`INSERT INTO "InventoryAlert"(id,"inventoryLevelId","quantityAtTrigger","thresholdAtTrigger",origin,"notificationAttempts","notificationLeaseToken") VALUES ('legacy-alert','legacy-level',3,5,'BASELINE',2,'existing-lease')`;
  const before = await fingerprints();
  cpSync(
    join("prisma/migrations", migration),
    join(temp, "migrations", migration),
    { recursive: true },
  );
  deploy();
  expect(await fingerprints()).toEqual(before);
  expect(await db.notificationDigest.count()).toBe(0);
  expect(
    await db.inventoryAlert.findUnique({ where: { id: "legacy-alert" } }),
  ).toMatchObject({
    digestId: null,
    notificationStatus: "PENDING",
    notificationAttempts: 2,
    notificationLeaseToken: "existing-lease",
  });
}, 60000);
afterAll(async () => {
  if (!/^m4_[a-f0-9]{32}$/.test(fixture.schema)) throw Error("Unsafe cleanup");
  try {
    await db.$executeRawUnsafe(
      `DROP SCHEMA IF EXISTS "${fixture.schema}" CASCADE`,
    );
  } finally {
    await db.$disconnect();
    if (
      temp &&
      dirname(resolve(temp)) === resolve(tmpdir()) &&
      temp.startsWith(join(tmpdir(), "stockpulse-m4-"))
    )
      rmSync(temp, { recursive: true, force: true });
  }
});
beforeEach(async () => {
  fixture.fail = false;
  fixture.failSync = false;
  shop = `digest-${randomUUID()}.myshopify.com`;
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "fixture-only");
  telegram
    .mockReset()
    .mockImplementation(async () => new Response(JSON.stringify({ ok: true })));
  vi.stubGlobal("fetch", telegram);
  await db.shopSettings.create({
    data: {
      shopDomain: shop,
      telegramChatId: "-123",
      locationsDiscoveredAt: new Date(),
    },
  });
  await db.session.create({
    data: {
      id: `offline_${shop}`,
      shop,
      state: "",
      isOnline: false,
      accessToken: "fixture-only",
    },
  });
  await db.monitoredLocation.createMany({
    data: [A, B, C].map((locationGid, i) => ({
      shopDomain: shop,
      locationGid,
      locationName: ["Main <warehouse>", "East & West", "Pending"][i],
      isActive: true,
    })),
  });
  vi.mocked(authenticate.admin).mockResolvedValue({
    session: new Session({
      id: `offline_${shop}`,
      shop,
      state: "",
      isOnline: false,
    }),
    admin: { graphql: vi.fn() },
  } as unknown as Awaited<ReturnType<typeof authenticate.admin>>);
});
afterEach(() => {
  fixture.fail = false;
  fixture.failSync = false;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
function filters(query = "") {
  return parseDashboardFilters(new URL(`https://app.test/app?${query}`));
}
function level(locationGid: string, quantity: number, inventoryItemGid = item) {
  return {
    shopDomain: shop,
    locationGid,
    inventoryItemGid,
    inventoryLevelGid: "gid://shopify/InventoryLevel/1?inventory_item_id=1",
    sku: null,
    variants: [
      {
        variantGid: "gid://shopify/ProductVariant/1",
        variantTitle: "Ice",
        productGid: "gid://shopify/Product/1",
        productTitle: "Board <b>&*",
      },
      {
        variantGid: "gid://shopify/ProductVariant/2",
        variantTitle: "Snow",
        productGid: "gid://shopify/Product/2",
        productTitle: "Second",
      },
    ],
    availableQuantity: quantity,
    shopifyUpdatedAt: new Date("2026-11-01T00:00:00Z"),
  };
}
async function scan(location: string, quantity: number) {
  const settings = (await getInventorySyncSettings(shop, location))!;
  return commitInventorySync(
    { ...settings, locationGid: location },
    [level(location, quantity)],
    new Date(),
    `offline_${shop}`,
  );
}
async function due() {
  await db.notificationDigest.updateMany({
    where: { shopDomain: shop, notifiedAt: null },
    data: { availableAt: new Date(0), nextAttemptAt: new Date(0) },
  });
}
async function batch() {
  return db.notificationDigest.findFirstOrThrow({
    where: { shopDomain: shop },
    orderBy: { createdAt: "desc" },
  });
}
async function snapshot() {
  return {
    settings: await db.shopSettings.findUnique({ where: { shopDomain: shop } }),
    locations: await db.monitoredLocation.findMany({
      where: { shopDomain: shop },
      orderBy: { locationGid: "asc" },
    }),
    alerts: await db.inventoryAlert.findMany({
      where: { inventoryLevel: { shopDomain: shop } },
      orderBy: { id: "asc" },
    }),
    levels: await db.inventoryLevel.findMany({
      where: { shopDomain: shop },
      orderBy: { id: "asc" },
    }),
  };
}

test("initial baseline aggregates locations in one durable batch, includes pending coverage and never schedules individuals", async () => {
  await scan(A, 0);
  await scan(B, -2);
  await scan(A, 0);
  expect(
    await db.notificationDigest.count({ where: { shopDomain: shop } }),
  ).toBe(1);
  expect(await processDigestForShop(shop)).toBe(false);
  expect(await processNotificationForShop(shop)).toBe(false);
  await due();
  expect(await processDigestForShop(shop)).toBe(true);
  const sent = await batch();
  expect(sent).toMatchObject({ status: "SENT", attempts: 1 });
  expect(sent.text).toContain("Low-stock items: 2");
  expect(sent.text).toContain("1 pending");
  expect(sent.text).toContain("0 / 5");
  expect(sent.text).toContain("-2 / 5");
  expect(
    (await snapshot()).alerts.every(
      (a) =>
        a.notificationStatus === "SENT" &&
        a.notifiedAt?.getTime() === sent.notifiedAt?.getTime(),
    ),
  ).toBe(true);
  expect(telegram).toHaveBeenCalledTimes(1);
  expect(
    JSON.parse(String(telegram.mock.calls[0][1]?.body)),
  ).not.toHaveProperty("parse_mode");
  expect(await processDigestForShop(shop)).toBe(false);
});

test("late failed/new location receives a supplement, repeated sync never recreates a sent batch", async () => {
  await scan(A, 3);
  await db.monitoredLocation.updateMany({
    where: { shopDomain: shop, locationGid: B },
    data: { lastSyncError: "Fixture failure" },
  });
  await due();
  await processDigestForShop(shop);
  expect((await batch()).text).toContain("1 failed");
  await scan(B, 2);
  await due();
  await processDigestForShop(shop);
  await scan(B, 2);
  expect(
    await db.notificationDigest.count({ where: { shopDomain: shop } }),
  ).toBe(2);
  expect(telegram).toHaveBeenCalledTimes(2);
  await scan(C, 1);
  expect(
    await db.notificationDigest.count({ where: { shopDomain: shop } }),
  ).toBe(3);
});

test("baseline coverage includes locations discovered during its aggregation window", async () => {
  await db.monitoredLocation.deleteMany({
    where: { shopDomain: shop, locationGid: C },
  });
  await scan(A, 3);
  expect((await batch()).locations).toHaveLength(2);
  await db.monitoredLocation.create({
    data: {
      shopDomain: shop,
      locationGid: C,
      locationName: "Discovered later",
      isActive: true,
    },
  });
  await due();
  await processDigestForShop(shop);
  expect((await batch()).locations).toHaveLength(3);
  expect((await batch()).text).toContain("2 pending");
  expect((await batch()).text).toContain("Discovered later: pending");
});

test("one threshold operation across locations creates one batch; no-op/decrease do not notify", async () => {
  await scan(A, 8);
  await scan(B, 7);
  await saveLowStockThreshold(shop, 9);
  expect(
    await db.notificationDigest.count({ where: { shopDomain: shop } }),
  ).toBe(1);
  expect(await batch()).toMatchObject({
    origin: "THRESHOLD_CHANGE",
    oldThreshold: 5,
    newThreshold: 9,
  });
  expect(await processNotificationForShop(shop)).toBe(false);
  await processDigestForShop(shop);
  expect((await batch()).text).toContain("Threshold: 5 → 9");
  await saveLowStockThreshold(shop, 9);
  await saveLowStockThreshold(shop, 2);
  expect(
    await db.notificationDigest.count({ where: { shopDomain: shop } }),
  ).toBe(1);
  expect(telegram).toHaveBeenCalledTimes(1);
});

test("parallel baselines share one aggregation window and creation rolls back with the inventory transaction", async () => {
  fixture.failSync = true;
  await expect(scan(A, 3)).rejects.toThrow("Injected sync rollback");
  fixture.failSync = false;
  expect(
    await db.notificationDigest.count({ where: { shopDomain: shop } }),
  ).toBe(0);
  expect((await snapshot()).alerts).toHaveLength(0);
  await Promise.all([scan(A, 3), scan(B, 2)]);
  expect(
    await db.notificationDigest.count({ where: { shopDomain: shop } }),
  ).toBe(1);
  expect((await snapshot()).alerts).toHaveLength(2);
});

test("threshold transaction failure also rolls back batch membership and configuration", async () => {
  await scan(A, 8);
  await scan(B, 7);
  const before = await snapshot();
  fixture.failSync = true;
  await expect(saveLowStockThreshold(shop, 9)).rejects.toThrow(
    "Injected sync rollback",
  );
  fixture.failSync = false;
  expect(await snapshot()).toEqual(before);
  expect(
    await db.notificationDigest.count({ where: { shopDomain: shop } }),
  ).toBe(0);
});

test("concurrent digest workers claim once, unique batch identity prevents duplicates", async () => {
  await scan(A, 3);
  await due();
  await Promise.all([processDigestForShop(shop), processDigestForShop(shop)]);
  expect(telegram).toHaveBeenCalledTimes(1);
  const saved = await batch();
  await expect(
    db.notificationDigest.create({
      data: {
        shopDomain: shop,
        batchKey: saved.batchKey,
        origin: saved.origin,
        chatId: saved.chatId,
        newThreshold: 5,
        locations: [],
        availableAt: new Date(),
      },
    }),
  ).rejects.toMatchObject({ code: "P2002" });
});

test("lease expiration/restart fences an old worker and retry exhaustion never invents SENT", async () => {
  await scan(A, 3);
  await due();
  const old = (await claimDigest(shop))!;
  await db.notificationDigest.update({
    where: { id: old.id },
    data: { leaseUntil: new Date(0) },
  });
  const owner = (await claimDigest(shop))!;
  expect(owner.leaseToken).not.toBe(old.leaseToken);
  expect(await finishDigest(old, { text: "stale", alertIds: [] })).toBe(0);
  await db.notificationDigest.update({
    where: { id: owner.id },
    data: { attempts: 3, leaseUntil: new Date(0) },
  });
  expect(await claimDigest(shop)).toBeNull();
  expect(await batch()).toMatchObject({
    status: "FAILED",
    notifiedAt: null,
    nextAttemptAt: null,
  });
});

test.each([429, 503, "timeout"] as const)(
  "digest retries %s durably and records SENT only after success",
  async (kind) => {
    await scan(A, 3);
    await due();
    if (kind === "timeout")
      telegram.mockRejectedValueOnce(
        new DOMException("timeout", "TimeoutError"),
      );
    else
      telegram.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ ok: false, parameters: { retry_after: 40 } }),
          { status: kind },
        ),
      );
    const now = Date.now();
    await processDigestForShop(shop);
    expect(await batch()).toMatchObject({
      status: "FAILED",
      notifiedAt: null,
      attempts: 1,
    });
    if (kind === 429)
      expect(
        (await batch()).nextAttemptAt!.getTime() - now,
      ).toBeGreaterThanOrEqual(39000);
    expect((await snapshot()).alerts[0].notificationStatus).toBe("PENDING");
    await due();
    await processDigestForShop(shop);
    expect(await batch()).toMatchObject({ status: "SENT", attempts: 2 });
  },
);

test("final DB failure rolls back digest/alert success; expired lease can recover", async () => {
  await scan(A, 3);
  await due();
  fixture.fail = true;
  await expect(processDigestForShop(shop)).rejects.toThrow("Injected");
  fixture.fail = false;
  expect(await batch()).toMatchObject({ status: "PENDING", notifiedAt: null });
  expect((await snapshot()).alerts[0].notificationStatus).toBe("PENDING");
  await db.notificationDigest.updateMany({
    where: { shopDomain: shop },
    data: { leaseUntil: new Date(0) },
  });
  await processDigestForShop(shop);
  expect((await batch()).status).toBe("SENT");
});

test("historical and pre-configuration alerts remain unscheduled without fake status changes", async () => {
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
  await scan(A, 3);
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "fixture-only");
  await scan(A, 3);
  expect(await processDigestForShop(shop)).toBe(false);
  expect((await snapshot()).alerts[0]).toMatchObject({
    digestId: null,
    notificationStatus: "PENDING",
    notifiedAt: null,
  });
  await saveTelegramChatId(shop, null);
  await scan(B, 3);
  await saveTelegramChatId(shop, "-123");
  expect(await processDigestForShop(shop)).toBe(false);
  expect(await processDigestForShop("legacy.myshopify.com")).toBe(false);
  expect(telegram).not.toHaveBeenCalled();
});

test("resolved/inactive members are excluded before delivery and an empty digest is cancelled", async () => {
  await scan(A, 3);
  await scan(B, 2);
  await scan(A, 8);
  await due();
  await processDigestForShop(shop);
  expect((await batch()).text).toContain("Low-stock items: 1");
  expect(
    (await snapshot()).alerts.find((a) => a.status === "RESOLVED")
      ?.notificationStatus,
  ).toBe("PENDING");
  await scan(C, 1);
  await scan(C, 8);
  await due();
  await processDigestForShop(shop);
  expect((await batch()).status).toBe("CANCELLED");
  expect(telegram).toHaveBeenCalledTimes(1);
});

test("destination changes cancel digest and foreign shops cannot claim or finalize it", async () => {
  await scan(A, 3);
  await due();
  expect(await claimDigest("foreign.myshopify.com")).toBeNull();
  const claim = (await claimDigest(shop))!;
  expect(
    await finishDigest({ ...claim, shopDomain: "foreign.myshopify.com" }, {}),
  ).toBe(0);
  await saveTelegramChatId(shop, "-456");
  expect(await readDigest(claim)).toBeNull();
  await finishDigest(claim, { cancelled: true });
  expect((await snapshot()).alerts[0].notificationStatus).toBe("PENDING");
});

test("INVENTORY_TRANSITION keeps immediate delivery and never enters a digest", async () => {
  await scan(A, 8);
  await scan(A, 4);
  expect(await processDigestForShop(shop)).toBe(false);
  expect(await processNotificationForShop(shop)).toBe(true);
  expect((await snapshot()).alerts[0]).toMatchObject({
    origin: "INVENTORY_TRANSITION",
    digestId: null,
    notificationStatus: "SENT",
  });
});

test("deterministic plain-text formatting stays within Telegram limit and reports omitted items accurately", async () => {
  await scan(A, 3);
  await due();
  const claim = (await claimDigest(shop))!;
  const data = (await readDigest(claim))!;
  data.alerts = Array.from({ length: 100 }, (_, i) => ({
    ...data.alerts[0],
    id: String(i),
  }));
  const text = formatDigest(claim, data);
  expect(text.length).toBeLessThanOrEqual(4096);
  expect(text).toContain("Low-stock items: 100");
  expect(text).toContain("more items omitted");
  expect(text).toBe(formatDigest(claim, data));
  expect(text).toContain("Board <b>&*");
});

test("authenticated dashboard/history loaders are read-only and cannot switch tenant from browser input", async () => {
  await scan(A, 0);
  await scan(B, -2);
  const before = await snapshot();
  const args = {
    request: new Request(
      `https://app.test/app?shop=foreign.myshopify.com&location=${encodeURIComponent(B)}`,
    ),
    params: {},
    context: {},
  } as LoaderFunctionArgs;
  const result = await dashboardLoader(args);
  expect(authenticate.admin).toHaveBeenCalledWith(args.request);
  expect(result.view.counts).toMatchObject({ items: 1, low: 1, products: 2 });
  expect(result.view.rows[0]).toMatchObject({
    sku: null,
    availableQuantity: -2,
    locationGid: B,
  });
  expect(result.view.rows[0].variants).toHaveLength(2);
  expect((await historyLoader(args)).view.rows).toHaveLength(1);
  expect(await snapshot()).toEqual(before);
});

test("history pagination includes resolved records and filters origin without hiding historical rows", async () => {
  await scan(A, 3);
  const saved = (await snapshot()).levels[0];
  await db.inventoryAlert.createMany({
    data: Array.from({ length: 24 }, (_, i) => ({
      inventoryLevelId: saved.id,
      quantityAtTrigger: i,
      thresholdAtTrigger: 5,
      status: "RESOLVED" as const,
      origin: "THRESHOLD_CHANGE" as const,
      resolvedAt: new Date(),
    })),
  });
  const first = await getAlertHistory(shop, filters());
  const next = await getAlertHistory(shop, filters("page=2"));
  expect(first.rows).toHaveLength(20);
  expect(next.rows).toHaveLength(5);
  expect(new Set([...first.rows, ...next.rows].map((r) => r.id)).size).toBe(25);
  expect(
    (await getAlertHistory(shop, filters("status=ACTIVE&origin=BASELINE")))
      .total,
  ).toBe(1);
  expect(
    (
      await getAlertHistory(
        shop,
        filters("status=RESOLVED&origin=THRESHOLD_CHANGE"),
      )
    ).total,
  ).toBe(24);
});

test("dashboard aggregates only current baseline-ready active snapshots; history preserves inactive locations", async () => {
  await scan(A, 0);
  await scan(B, -2);
  const { inventoryLevelGid, ...pending } = level(C, 1);
  expect(inventoryLevelGid).toContain("?inventory_item_id=");
  await db.inventoryLevel.create({
    data: { ...pending, isLowStock: true, isCurrent: true },
  });
  expect((await getDashboard(shop, filters())).counts).toMatchObject({
    items: 2,
    low: 2,
    products: 2,
    active: 2,
  });
  await db.monitoredLocation.updateMany({
    where: { shopDomain: shop, locationGid: B },
    data: { isActive: false },
  });
  expect((await getDashboard(shop, filters())).counts.items).toBe(1);
  expect((await getAlertHistory(shop, filters())).rows).toHaveLength(2);
  await db.inventoryLevel.updateMany({
    where: { shopDomain: shop, locationGid: A },
    data: { isCurrent: false },
  });
  expect((await getDashboard(shop, filters())).counts.items).toBe(0);
});

test("server-side search, stock filtering and stable inventory/history pagination isolate shops", async () => {
  await scan(A, 8);
  for (let i = 2; i <= 24; i++) {
    const { inventoryLevelGid, ...data } = level(
      A,
      i % 2 === 0 ? 0 : 10,
      `gid://shopify/InventoryItem/${i}`,
    );
    expect(inventoryLevelGid).toContain("?inventory_item_id=");
    await db.inventoryLevel.create({
      data: {
        ...data,
        sku: `SKU-${i}`,
        isCurrent: true,
        isLowStock: data.availableQuantity <= 5,
      },
    });
  }
  const all = await getDashboard(shop, filters());
  const next = await getDashboard(shop, filters("page=2"));
  expect(all.rows).toHaveLength(20);
  expect(next.rows).toHaveLength(4);
  expect(new Set([...all.rows, ...next.rows].map((r) => r.id)).size).toBe(24);
  expect(
    (await getDashboard(shop, filters("q=SKU-24&stock=low"))).rows,
  ).toHaveLength(1);
  expect((await getDashboard(shop, filters("q=Snow"))).total).toBe(24);
  expect((await getDashboard("foreign.myshopify.com", filters())).total).toBe(
    0,
  );
  expect((await getDashboard(shop, filters("stock=normal"))).counts.items).toBe(
    24,
  );
});

test("SSR uses real data and prototype hierarchy, with empty/error states and actual settings controls", async () => {
  await scan(A, 0);
  await scan(B, -2);
  const args = {
    request: new Request("https://app.test/app"),
    params: {},
    context: {},
  } as LoaderFunctionArgs;
  const dashboard = await dashboardLoader(args);
  const history = await historyLoader(args);
  mkdirSync("node_modules/.cache/stockpulse-m4", { recursive: true });
  const routes = [
    {
      id: "routes/app",
      path: "/app",
      children: [
        {
          id: "dashboard",
          index: true,
          element: createElement(Dashboard),
          errorElement: createElement(DashboardErrorBoundary),
        },
        { id: "history", path: "alerts", element: createElement(AlertHistory) },
        { id: "settings", path: "settings", element: createElement(Settings) },
      ],
    },
  ];
  const loaderData = {
    "routes/app": { coverage: dashboard.view.coverage, apiKey: "fixture" },
    dashboard,
    history,
    settings: {
      selected: { lowStockThreshold: 5, telegramChatId: "-123" },
      locations: [],
      error: null,
      botConfigured: true,
    },
  };
  for (const [name, path] of [
    ["dashboard", "/app"],
    ["history", "/app/alerts"],
    ["settings", "/app/settings"],
  ]) {
    const router = createMemoryRouter(routes, {
      initialEntries: [path],
      hydrationData: { loaderData },
    });
    const html = renderToString(createElement(RouterProvider, { router }));
    writeFileSync(`node_modules/.cache/stockpulse-m4/${name}.html`, html);
    expect(html).not.toContain("HTML MOCKUP");
    expect(html).not.toContain('class="sidebar"');
    if (name === "dashboard") {
      expect(html).toContain(
        '<s-button slot="primary-action" variant="primary">Sync all locations</s-button>',
      );
      expect(html).toContain("Previous");
      expect(html).toContain("Next");
      expect(html).toContain("Location coverage");
      expect(html).toContain("Board &lt;b&gt;&amp;*");
      expect(html).toContain("All locations");
      expect(html).toContain("Baseline pending");
    }
    if (name === "history") {
      expect(html).toContain("Inventory alerts");
      expect(html).toContain("Digest pending");
    }
    if (name === "settings") {
      expect(html).toContain("Save threshold");
      expect(html).toContain("Send test message");
      expect(html).toContain("Process liveness is not reported");
    }
    router.dispose();
  }
  const empty = renderToString(
    createElement(
      EmptyState,
      { heading: "No matching items" },
      "Try another filter.",
    ),
  );
  expect(empty).toContain("No matching items");
  const failed = createMemoryRouter(routes, {
    initialEntries: ["/app"],
    hydrationData: {
      loaderData,
      errors: { dashboard: Error("private database message") },
    },
  });
  const errorHtml = renderToString(
    createElement(RouterProvider, { router: failed }),
  );
  expect(errorHtml).toContain("Couldn&#x27;t load inventory");
  expect(errorHtml).not.toContain("private database message");
  failed.dispose();
});

test("authentication rejection reaches the template boundary without inventory access", async () => {
  vi.mocked(authenticate.admin).mockRejectedValueOnce(
    new Response(null, { status: 401 }),
  );
  await expect(
    dashboardLoader({
      request: new Request("https://app.test/app?shop=forged"),
      params: {},
      context: {},
    } as LoaderFunctionArgs),
  ).rejects.toMatchObject({ status: 401 });
});
