import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import db from "../app/db.server";
import { saveLocationSettings } from "../app/modules/settings/settings.repository.server";
import {
  commitInventorySync,
  getInventorySyncSettings,
} from "../app/modules/inventory/inventory.repository.server";

const isolated = vi.hoisted(() => ({
  schema: `m1_${globalThis.crypto.randomUUID().replaceAll("-", "")}`,
}));
vi.mock("../app/db.server", async () => {
  const { PrismaClient } = await import("@prisma/client");
  const url = new URL(process.env.DATABASE_URL ?? "http://missing");
  if (
    !["localhost", "127.0.0.1"].includes(url.hostname) ||
    url.port !== "5433" ||
    url.pathname !== "/stocknotifier"
  )
    throw new Error(
      "M1 migration tests require local Compose PostgreSQL on 5433",
    );
  url.searchParams.set("schema", isolated.schema);
  return { default: new PrismaClient({ datasourceUrl: url.toString() }) };
});

const migration = "20261102000000_monitored_location_foundation";
const locationGid = "gid://shopify/Location/271878346596884015";
const shops = ["synced", "pending", "unset"].map(
  (name) => `m1-${name}-${randomUUID()}.myshopify.com`,
);
const lastSyncedAt = new Date("2026-11-01T12:34:56.789Z");
let workspace: string;
let before: Awaited<ReturnType<typeof legacyState>>;
let originalIndexes: unknown;

function deploy() {
  const url = new URL(process.env.DATABASE_URL!);
  url.searchParams.set("schema", isolated.schema);
  // Only the generated schema is migrated; never apply M1 to public/merchant data.
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
      timeout: 30000,
      stdio: "pipe",
    },
  );
}

async function legacyState() {
  return {
    sessions: await db.session.findMany({ orderBy: { id: "asc" } }),
    settings: await db.shopSettings.findMany({
      orderBy: { shopDomain: "asc" },
      omit: { locationsDiscoveredAt: true },
    }),
    levels: await db.inventoryLevel.findMany({ orderBy: { id: "asc" } }),
    alerts: await db.inventoryAlert.findMany({
      orderBy: { id: "asc" },
      omit: { origin: true },
    }),
    events: await db.webhookEvent.findMany({ orderBy: { id: "asc" } }),
  };
}

function indexes() {
  return db.$queryRaw`
    SELECT indexname, indexdef FROM pg_indexes
    WHERE schemaname = ${isolated.schema} AND tablename <> 'MonitoredLocation'
    ORDER BY indexname
  `;
}

beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), "stockpulse-m1-"));
  cpSync("prisma/schema.prisma", join(workspace, "schema.prisma"));
  cpSync("prisma/migrations", join(workspace, "migrations"), {
    recursive: true,
    filter: (source) =>
      !source.includes(migration) &&
      !source.includes("20261102010000_multi_location_runtime"),
  });
  await db.$executeRawUnsafe(`CREATE SCHEMA "${isolated.schema}"`);
  deploy();
  await db.shopSettings.createMany({
    data: [
      {
        shopDomain: shops[0],
        locationGid,
        locationName: "Warehouse",
        lastSyncedAt,
      },
      { shopDomain: shops[1], locationGid, locationName: null },
      { shopDomain: shops[2] },
    ],
  });
  await db.session.create({
    data: {
      id: `offline_${shops[0]}`,
      shop: shops[0],
      state: "fixture",
      isOnline: false,
      accessToken: "fixture-only",
      refreshToken: "fixture-refresh",
    },
  });
  const level = await db.inventoryLevel.create({
    data: {
      shopDomain: shops[0],
      locationGid,
      inventoryItemGid: "gid://shopify/InventoryItem/2",
      variants: [],
      availableQuantity: 3,
      isLowStock: true,
      syncedAt: lastSyncedAt,
    },
  });
  // Seed the pre-M2 shape: current Prisma defaults include origin, which did not exist yet.
  await db.$executeRaw`INSERT INTO "InventoryAlert" (
    id,"inventoryLevelId","quantityAtTrigger","thresholdAtTrigger","notificationChatId","notificationText",
    "notificationAttempts","notificationStatus","notificationNextAttemptAt","notificationLeaseUntil","notificationLeaseToken","notificationError"
  ) VALUES ('m1-active',${level.id},3,5,'-100123','Fixture only',2,'FAILED',${lastSyncedAt},${lastSyncedAt},'fixture-lease','Fixture error')`;
  await db.$executeRaw`INSERT INTO "InventoryAlert" (
    id,"inventoryLevelId","quantityAtTrigger","thresholdAtTrigger",status,"resolvedAt","notificationStatus","notifiedAt"
  ) VALUES ('m1-resolved',${level.id},4,5,'RESOLVED',${lastSyncedAt},'SENT',${lastSyncedAt})`;
  await db.webhookEvent.create({
    data: { shopDomain: shops[0], webhookId: "fixture-delivery" },
  });
  before = await legacyState();
  originalIndexes = await indexes();
  cpSync(
    join("prisma/migrations", migration),
    join(workspace, "migrations", migration),
    { recursive: true },
  );
  deploy();
  cpSync(
    join("prisma/migrations", "20261102010000_multi_location_runtime"),
    join(workspace, "migrations", "20261102010000_multi_location_runtime"),
    { recursive: true },
  );
  deploy();
}, 60000);

afterAll(async () => {
  // This generated schema contains fixtures only, never the public schema.
  if (!/^m1_[a-f0-9]{32}$/.test(isolated.schema))
    throw new Error("Unsafe schema cleanup");
  try {
    await db.$executeRawUnsafe(
      `DROP SCHEMA IF EXISTS "${isolated.schema}" CASCADE`,
    );
  } finally {
    await db.$disconnect();
    if (
      workspace &&
      dirname(resolve(workspace)) === resolve(tmpdir()) &&
      workspace.startsWith(join(tmpdir(), "stockpulse-m1-"))
    ) {
      rmSync(workspace, { recursive: true, force: true });
    }
  }
});

test("actual Prisma migration/backfill preserves every legacy row, alert status, delivery field and index", async () => {
  expect(await legacyState()).toEqual(before);
  expect(await indexes()).toEqual(originalIndexes);
  const rows = await db.monitoredLocation.findMany({
    orderBy: { shopDomain: "asc" },
  });
  expect(rows).toHaveLength(2);
  expect(rows.find((row) => row.shopDomain === shops[0])).toMatchObject({
    locationGid,
    locationName: "Warehouse",
    isActive: null,
    syncStatus: "READY",
    baselineCompletedAt: lastSyncedAt,
    lastSyncedAt,
    version: 0n,
    createdAt: before.settings.find((shop) => shop.shopDomain === shops[0])!
      .createdAt,
    updatedAt: before.settings.find((shop) => shop.shopDomain === shops[0])!
      .updatedAt,
  });
  expect(rows.find((row) => row.shopDomain === shops[1])).toMatchObject({
    locationGid,
    locationName: null,
    isActive: null,
    syncStatus: "PENDING",
    baselineCompletedAt: null,
    lastSyncedAt: null,
    version: 0n,
  });
  expect(
    await db.monitoredLocation.count({ where: { shopDomain: shops[2] } }),
  ).toBe(0);
  expect(deploy()).toContain("No pending migrations");
});

test("backfill can repeat without overwriting existing verified location state", async () => {
  const key = { shopDomain: shops[0], locationGid };
  await db.monitoredLocation.update({
    where: { shopDomain_locationGid: key },
    data: {
      isActive: true,
      locationName: "Verified name",
      version: 9007199254740993n,
    },
  });
  const saved = await db.monitoredLocation.findMany({
    orderBy: { shopDomain: "asc" },
  });
  const sql = readFileSync(
    join("prisma/migrations", migration, "migration.sql"),
    "utf8",
  );
  const backfill = sql.slice(
    sql.indexOf('INSERT INTO "MonitoredLocation"'),
    sql.indexOf("COMMIT;"),
  );
  await db.$executeRawUnsafe(backfill);
  expect(
    await db.monitoredLocation.findMany({ orderBy: { shopDomain: "asc" } }),
  ).toEqual(saved);
  expect(await legacyState()).toEqual(before);
});

test("composite identity supports multiple locations and isolates shops, defaults and versions", async () => {
  const key = {
    shopDomain: shops[0],
    locationGid: "gid://shopify/Location/99",
  };
  const created = await db.monitoredLocation.create({ data: key });
  expect(created).toMatchObject({
    isActive: null,
    syncStatus: "PENDING",
    lastSyncedAt: null,
    baselineCompletedAt: null,
    version: 0n,
  });
  expect(
    await db.monitoredLocation.count({ where: { shopDomain: shops[0] } }),
  ).toBe(2);
  await expect(
    db.monitoredLocation.create({ data: key }),
  ).rejects.toMatchObject({ code: "P2002" });
  await expect(
    db.monitoredLocation.create({
      data: { ...key, shopDomain: "missing.myshopify.com" },
    }),
  ).rejects.toMatchObject({ code: "P2003" });
  await db.monitoredLocation.update({
    where: { shopDomain_locationGid: key },
    data: { version: { increment: 1 } },
  });
  expect(
    (
      await db.monitoredLocation.findUniqueOrThrow({
        where: { shopDomain_locationGid: key },
      })
    ).version,
  ).toBe(1n);
  expect(
    (
      await db.monitoredLocation.findUniqueOrThrow({
        where: {
          shopDomain_locationGid: { shopDomain: shops[1], locationGid },
        },
      })
    ).version,
  ).toBe(0n);
});

test("existing Settings and Sync still use legacy baseline and do not dual-write monitored locations", async () => {
  const shopDomain = shops[2];
  await saveLocationSettings(shopDomain, {
    locationGid,
    locationName: "Selected",
  });
  const initial = (await getInventorySyncSettings(shopDomain))!;
  const item = {
    shopDomain,
    locationGid,
    inventoryItemGid: "gid://shopify/InventoryItem/8",
    inventoryLevelGid: "gid://shopify/InventoryLevel/7?inventory_item_id=8",
    variants: [],
    sku: null,
    availableQuantity: 8,
    shopifyUpdatedAt: lastSyncedAt,
  };
  expect(
    await commitInventorySync({ ...initial, locationGid }, [item], new Date()),
  ).toMatchObject({ baseline: true, alertsCreated: 0 });
  const settings = (await getInventorySyncSettings(shopDomain))!;
  expect(settings.lastSyncedAt).toBeInstanceOf(Date);
  expect(
    await commitInventorySync(
      { ...settings, locationGid },
      [{ ...item, availableQuantity: 3 }],
      new Date(),
    ),
  ).toMatchObject({ baseline: false, alertsCreated: 1 });
  expect(await db.monitoredLocation.count({ where: { shopDomain } })).toBe(0);
  expect(
    await db.inventoryAlert.count({
      where: { inventoryLevel: { shopDomain }, status: "ACTIVE" },
    }),
  ).toBe(1);
});
