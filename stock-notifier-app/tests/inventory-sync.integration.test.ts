import { randomUUID } from "node:crypto";
import { env } from "node:process";
import { Session } from "@shopify/shopify-api";
import type { AdminGraphqlClient } from "@shopify/shopify-app-react-router/server";
import type { ActionFunctionArgs } from "react-router";
import { afterAll, afterEach, beforeEach, expect, test, vi } from "vitest";
import db from "../app/db.server";
import { authenticate } from "../app/shopify.server";
import { action } from "../app/routes/app.inventory-sync";
import {
  InventorySyncError,
  syncInventory,
} from "../app/modules/inventory/inventory-sync.service.server";
import { saveLocationSettings } from "../app/modules/settings/settings.repository.server";
import {
  INVENTORY_ITEM_QUERY,
  LOCATION_INVENTORY_QUERY,
} from "../app/modules/shopify/graphql/queries";
import type {
  Connection,
  InventoryLevelNode,
  VariantNode,
} from "../app/modules/shopify/graphql/types";

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
              throw new Error("Injected final sync write failure");
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
  throw new Error("Sync tests require the local Compose database on port 5433");
}

const locationA = "gid://shopify/Location/1";
const locationB = "gid://shopify/Location/2";
const oldDate = new Date("2026-10-01T00:00:00Z");
const remoteDate = "2026-10-31T10:00:00Z";
let shop: string;
let otherShop: string;
let graphql: ReturnType<typeof vi.fn<AdminGraphqlClient>>;

beforeEach(async () => {
  failure.enabled = false;
  shop = `sync-${randomUUID()}.myshopify.com`;
  otherShop = `sync-other-${randomUUID()}.myshopify.com`;
  graphql = vi.fn<AdminGraphqlClient>();
  await db.shopSettings.createMany({
    data: [shop, otherShop].map((shopDomain) => ({
      shopDomain,
      locationGid: locationA,
      locationName: "Warehouse",
      updatedAt: oldDate,
    })),
  });
});

afterEach(async () => {
  failure.enabled = false;
  vi.useRealTimers();
  const shops = { in: [shop, otherShop] };
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

function context(client = graphql) {
  return {
    admin: { graphql: client },
    session: new Session({ id: "fixture", shop, state: "", isOnline: false }),
  };
}
function connection<T>(
  nodes: T[],
  cursor: string | null = null,
): Connection<T> {
  return {
    nodes,
    pageInfo: { hasNextPage: cursor !== null, endCursor: cursor },
  };
}
function variant(id: string): VariantNode {
  return {
    id: `gid://shopify/ProductVariant/${id}`,
    title: id,
    product: { id: "gid://shopify/Product/1", title: "Product" },
  };
}
function level(id: string, quantity: number | null = 3): InventoryLevelNode {
  return {
    id: `gid://shopify/InventoryLevel/${id}?inventory_item_id=${id}`,
    isActive: true,
    updatedAt: remoteDate,
    quantities: [{ name: "available", quantity }],
    item: {
      id: `gid://shopify/InventoryItem/${id}`,
      sku: null,
      tracked: true,
      variants: connection([variant(id)]),
    },
  };
}
function page(nodes: InventoryLevelNode[], cursor: string | null = null) {
  return new Response(
    JSON.stringify({
      data: {
        location: {
          id: locationA,
          isActive: true,
          inventoryLevels: connection(nodes, cursor),
        },
      },
    }),
  );
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function seed(
  id: string,
  shopDomain = shop,
  locationGid = locationA,
  alert = false,
) {
  return db.inventoryLevel.create({
    data: {
      shopDomain,
      locationGid,
      inventoryItemGid: `gid://shopify/InventoryItem/${id}`,
      variants: [],
      sku: "old",
      availableQuantity: 12,
      isLowStock: false,
      isCurrent: true,
      shopifyUpdatedAt: oldDate,
      syncedAt: oldDate,
      ...(alert
        ? {
            alerts: {
              create: {
                quantityAtTrigger: 2,
                thresholdAtTrigger: 5,
                notificationStatus: "SENT",
              },
            },
          }
        : {}),
    },
  });
}
async function state() {
  const scope = { shopDomain: { in: [shop, otherShop] } };
  return {
    settings: await db.shopSettings.findMany({
      where: scope,
      orderBy: { shopDomain: "asc" },
    }),
    levels: await db.inventoryLevel.findMany({
      where: scope,
      orderBy: { id: "asc" },
    }),
    alerts: await db.inventoryAlert.findMany({
      where: { inventoryLevel: scope },
      orderBy: { id: "asc" },
    }),
  };
}

test("all inventory/variant pages finish before any write; repeat upserts preserve one snapshot per item and baseline creates no alert", async () => {
  const original = await seed("101");
  const first = level("101", 0);
  first.item.variants = connection([variant("11")], "variant-next");
  async function scan() {
    const before = await state();
    const responses = [
      page([first], "level-next"),
      new Response(
        JSON.stringify({
          data: {
            inventoryItem: {
              ...first.item,
              variants: connection([variant("12"), variant("13")]),
            },
          },
        }),
      ),
      page([level("102", -3), level("103", 5), level("104", 6)]),
    ];
    graphql.mockImplementation(async () => {
      expect(await state()).toEqual(before);
      const response = responses.shift();
      if (!response) throw new Error("Unexpected extra GraphQL request");
      return response;
    });
    const result = await syncInventory(context());
    expect(responses).toHaveLength(0);
    return result;
  }
  expect(await scan()).toMatchObject({ baseline: true, itemCount: 4 });
  expect(graphql.mock.calls.map(([query]) => query)).toEqual([
    LOCATION_INVENTORY_QUERY,
    INVENTORY_ITEM_QUERY,
    LOCATION_INVENTORY_QUERY,
  ]);
  const firstRows = await db.inventoryLevel.findMany({
    where: { shopDomain: shop },
    orderBy: { inventoryItemGid: "asc" },
  });
  expect(
    firstRows.map((row) => [row.availableQuantity, row.isLowStock, row.sku]),
  ).toEqual([
    [0, true, null],
    [-3, true, null],
    [5, true, null],
    [6, false, null],
  ]);
  expect(firstRows[0].id).toBe(original.id);
  expect(firstRows[0].variants).toEqual(
    ["11", "12", "13"].map((id) => ({
      variantGid: `gid://shopify/ProductVariant/${id}`,
      variantTitle: id,
      productGid: "gid://shopify/Product/1",
      productTitle: "Product",
    })),
  );
  expect(firstRows[0].shopifyUpdatedAt).toEqual(new Date(remoteDate));
  expect(
    await db.inventoryAlert.count({
      where: { inventoryLevel: { shopDomain: shop } },
    }),
  ).toBe(0);
  expect(await scan()).toMatchObject({ baseline: false, itemCount: 4 });
  const repeated = await db.inventoryLevel.findMany({
    where: { shopDomain: shop },
    orderBy: { inventoryItemGid: "asc" },
  });
  expect(repeated.map((row) => row.id)).toEqual(firstRows.map((row) => row.id));
  const settings = await db.shopSettings.findUniqueOrThrow({
    where: { shopDomain: shop },
  });
  expect(
    repeated.every(
      (row) =>
        row.isCurrent &&
        row.syncedAt.getTime() === settings.lastSyncedAt?.getTime(),
    ),
  ).toBe(true);
});

test.each(["inventory", "variants"])(
  "a later %s page failure leaves snapshots, alerts and sync markers untouched",
  async (kind) => {
    await seed("101", shop, locationA, true);
    const before = await state();
    const first = level("101", 0);
    if (kind === "variants")
      first.item.variants = connection([variant("1")], "next-variant");
    graphql
      .mockResolvedValueOnce(
        page([first], kind === "inventory" ? "next-level" : null),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: null,
            errors: [{ message: "Page unavailable" }],
          }),
        ),
      );
    await expect(syncInventory(context())).rejects.toThrow("Page unavailable");
    expect(await state()).toEqual(before);
  },
);

test("failure at the final settings write rolls back upserts, invalidation and alert resolution together", async () => {
  await seed("101");
  await seed("999", shop, locationA, true);
  const before = await state();
  graphql.mockResolvedValueOnce(page([level("101", 0), level("102", -1)]));
  failure.enabled = true;
  await expect(syncInventory(context())).rejects.toThrow(
    "Injected final sync write failure",
  );
  failure.enabled = false;
  expect(await state()).toEqual(before);
});

test.each(["empty", "ineligible"])(
  "a successful %s scan invalidates only the selected scope and preserves alert history",
  async (kind) => {
    const old = await seed("101", shop, locationA, true);
    const foreign = await seed("101", otherShop, locationA, true);
    const otherLocation = await seed("101", shop, locationB, true);
    const history = await db.inventoryAlert.create({
      data: {
        inventoryLevelId: old.id,
        quantityAtTrigger: 3,
        thresholdAtTrigger: 5,
        status: "RESOLVED",
        resolvedAt: oldDate,
        notificationStatus: "FAILED",
      },
    });
    const untracked = level("101");
    untracked.item.tracked = false;
    graphql.mockResolvedValueOnce(
      page(kind === "empty" ? [] : [untracked, level("102", null)]),
    );
    const result = await syncInventory(context());
    expect(result).toMatchObject({
      itemCount: 0,
      staleCount: 1,
      baseline: true,
    });
    expect(
      await db.inventoryLevel.findUnique({ where: { id: old.id } }),
    ).toMatchObject({ isCurrent: false, availableQuantity: 12 });
    expect(
      await db.inventoryAlert.findUnique({ where: { id: history.id } }),
    ).toEqual(history);
    expect(
      await db.inventoryAlert.count({
        where: { inventoryLevelId: old.id, status: "ACTIVE" },
      }),
    ).toBe(0);
    for (const untouched of [foreign, otherLocation]) {
      expect(
        await db.inventoryLevel.findUnique({ where: { id: untouched.id } }),
      ).toMatchObject({ isCurrent: true });
      expect(
        await db.inventoryAlert.count({
          where: { inventoryLevelId: untouched.id, status: "ACTIVE" },
        }),
      ).toBe(1);
    }
    expect(
      await db.inventoryLevel.count({
        where: { shopDomain: shop, locationGid: locationA },
      }),
    ).toBe(1);
    expect(
      (await db.shopSettings.findUniqueOrThrow({ where: { shopDomain: shop } }))
        .lastSyncedAt,
    ).toEqual(result.syncedAt);
  },
);

test.each([false, true])(
  "location change during scan aborts old results, including same-millisecond A -> B -> A: %s",
  async (returnToA) => {
    await seed("101", shop, locationA, true);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(oldDate);
    const entered = deferred<void>();
    const release = deferred<Response>();
    graphql.mockImplementationOnce(() => {
      entered.resolve();
      return release.promise;
    });
    const pending = expect(syncInventory(context())).rejects.toBeInstanceOf(
      InventorySyncError,
    );
    await entered.promise;
    await saveLocationSettings(shop, {
      locationGid: locationB,
      locationName: "B",
    });
    if (returnToA)
      await saveLocationSettings(shop, {
        locationGid: locationA,
        locationName: "A",
      });
    const afterLocationChange = await state();
    release.resolve(page([level("101", 0)]));
    await pending;
    expect(await state()).toEqual(afterLocationChange);
    expect(
      (await db.shopSettings.findUniqueOrThrow({ where: { shopDomain: shop } }))
        .lastSyncedAt,
    ).toBeNull();
    if (returnToA) {
      graphql.mockResolvedValueOnce(page([level("101", 0)]));
      expect(await syncInventory(context())).toMatchObject({
        baseline: true,
        itemCount: 1,
      });
      expect(
        await db.inventoryAlert.count({
          where: { inventoryLevel: { shopDomain: shop } },
        }),
      ).toBe(1);
      expect(
        await db.inventoryAlert.count({
          where: { inventoryLevel: { shopDomain: shop }, status: "ACTIVE" },
        }),
      ).toBe(0);
    }
  },
);

test("a slower concurrent sync cannot overwrite the winning scan, even with an unchanged wall clock", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(oldDate);
  const entered = deferred<void>();
  const release = deferred<Response>();
  graphql.mockImplementationOnce(() => {
    entered.resolve();
    return release.promise;
  });
  const pending = expect(syncInventory(context())).rejects.toBeInstanceOf(
    InventorySyncError,
  );
  await entered.promise;
  const fast = vi
    .fn<AdminGraphqlClient>()
    .mockResolvedValueOnce(page([level("101", 8)]));
  await syncInventory(context(fast));
  const winner = await state();
  release.resolve(page([level("102", 0)]));
  await pending;
  expect(await state()).toEqual(winner);
  expect(winner.levels).toHaveLength(1);
  expect(winner.levels[0].availableQuantity).toBe(8);
});

test.each(["present", "missing", "same-millisecond-missing"])(
  "a snapshot updated during scan is neither overwritten nor invalidated: %s",
  async (kind) => {
    const saved = await seed("101");
    if (kind === "same-millisecond-missing") {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(oldDate);
    }
    const entered = deferred<void>();
    const release = deferred<Response>();
    graphql.mockImplementationOnce(() => {
      entered.resolve();
      return release.promise;
    });
    const pending = expect(syncInventory(context())).rejects.toBeInstanceOf(
      InventorySyncError,
    );
    await entered.promise;
    await db.inventoryLevel.update({
      where: { id: saved.id },
      data: {
        availableQuantity: 20,
        shopifyUpdatedAt: new Date("2026-11-01T00:00:00Z"),
        syncedAt: new Date(
          Date.now() + (kind === "same-millisecond-missing" ? 0 : 1000),
        ),
      },
    });
    const changed = await state();
    release.resolve(page(kind === "present" ? [level("101", 0)] : []));
    await pending;
    expect(await state()).toEqual(changed);
  },
);

test("the sync action ignores forged shop/location fields and uses authenticated settings", async () => {
  const foreign = await seed("101", otherShop, locationA);
  graphql.mockResolvedValueOnce(page([level("101", 0)]));
  const auth = context();
  vi.mocked(authenticate.admin).mockResolvedValue(
    auth as unknown as Awaited<ReturnType<typeof authenticate.admin>>,
  );
  const request = new Request("https://app.test/app/inventory-sync", {
    method: "POST",
    body: new URLSearchParams({
      shopDomain: otherShop,
      locationGid: locationB,
    }),
  });
  const result = await action({
    request,
    params: {},
    context: {},
  } as ActionFunctionArgs);
  expect(result.data.error).toBeNull();
  expect(authenticate.admin).toHaveBeenCalledWith(request);
  expect(graphql.mock.calls[0][1]?.variables).toMatchObject({
    locationId: locationA,
  });
  expect(
    await db.inventoryLevel.findUnique({ where: { id: foreign.id } }),
  ).toEqual(foreign);
  expect(
    await db.inventoryLevel.count({
      where: { shopDomain: shop, locationGid: locationA },
    }),
  ).toBe(1);
  expect(
    await db.inventoryLevel.count({
      where: { shopDomain: shop, locationGid: locationB },
    }),
  ).toBe(0);
});
