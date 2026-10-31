import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GraphqlQueryError,
  HttpResponseError,
  Session,
} from "@shopify/shopify-api";
import type { AdminGraphqlClient } from "@shopify/shopify-app-react-router/server";
import {
  createShopifyGraphqlService,
  ShopifyGraphqlError,
} from "../app/modules/shopify/graphql/shopify-graphql.server";
import {
  INVENTORY_ITEM_QUERY,
  LOCATION_INVENTORY_QUERY,
  LOCATIONS_QUERY,
} from "../app/modules/shopify/graphql/queries";
import type {
  Connection,
  GraphqlEnvelope,
  InventoryItemNode,
  InventoryLevelNode,
  VariantNode,
} from "../app/modules/shopify/graphql/types";

const locationGid = "gid://shopify/Location/1";
const itemGid = "gid://shopify/InventoryItem/2";
const levelGid = "gid://shopify/InventoryLevel/3?inventory_item_id=2";

function connection<T>(
  nodes: T[],
  endCursor: string | null = null,
): Connection<T> {
  return { nodes, pageInfo: { hasNextPage: endCursor !== null, endCursor } };
}

function variant(id = "1"): VariantNode {
  return {
    id: `gid://shopify/ProductVariant/${id}`,
    title: `Variant ${id}`,
    product: { id: "gid://shopify/Product/1", title: "Product" },
  };
}

function item(overrides: Partial<InventoryItemNode> = {}): InventoryItemNode {
  return {
    id: itemGid,
    sku: "SKU",
    tracked: true,
    variants: connection([variant()]),
    ...overrides,
  };
}

function level(
  overrides: Partial<InventoryLevelNode> = {},
): InventoryLevelNode {
  return {
    id: levelGid,
    isActive: true,
    updatedAt: "2026-11-01T01:00:00Z",
    quantities: [{ name: "available", quantity: 5 }],
    item: item(),
    ...overrides,
  };
}

function response(
  data: unknown,
  extra: Omit<GraphqlEnvelope<unknown>, "data"> = {},
) {
  return new Response(JSON.stringify({ data, ...extra }), {
    headers: { "Content-Type": "application/json" },
  });
}

function inventoryResponse(
  levels: InventoryLevelNode[],
  cursor: string | null = null,
) {
  return response({
    location: {
      id: locationGid,
      isActive: true,
      inventoryLevels: connection(levels, cursor),
    },
  });
}

function setup() {
  const graphql = vi.fn<AdminGraphqlClient>();
  const service = createShopifyGraphqlService({
    admin: { graphql },
    session: new Session({
      id: "offline_fixture",
      shop: "fixture.myshopify.com",
      state: "fixture",
      isOnline: false,
    }),
  });
  return { graphql, service };
}

afterEach(() => vi.useRealTimers());

describe("Shopify read service", () => {
  it("paginates locations using variables and returns only active locations", async () => {
    const { graphql, service } = setup();
    graphql
      .mockResolvedValueOnce(
        response({
          locations: connection(
            [{ id: locationGid, name: "Warehouse", isActive: true }],
            "loc-next",
          ),
        }),
      )
      .mockResolvedValueOnce(
        response({
          locations: connection([
            { id: "inactive", name: "Old", isActive: false },
            { id: "second", name: "New", isActive: true },
          ]),
        }),
      );
    expect(await service.getLocations()).toEqual([
      { locationGid, locationName: "Warehouse" },
      { locationGid: "second", locationName: "New" },
    ]);
    expect(graphql).toHaveBeenNthCalledWith(1, LOCATIONS_QUERY, {
      variables: { first: 50, after: null },
      tries: 1,
    });
    expect(graphql).toHaveBeenNthCalledWith(2, LOCATIONS_QUERY, {
      variables: { first: 50, after: "loc-next" },
      tries: 1,
    });
  });

  it("paginates levels and nested variants independently, preserving complete GIDs and one result per item", async () => {
    const { graphql, service } = setup();
    graphql
      .mockResolvedValueOnce(
        inventoryResponse(
          [
            level({
              item: item({ variants: connection([variant("1")], "variant-1") }),
            }),
          ],
          "level-next",
        ),
      )
      .mockResolvedValueOnce(
        response({
          inventoryItem: item({
            variants: connection([variant("2")], "variant-2"),
          }),
        }),
      )
      .mockResolvedValueOnce(
        response({
          inventoryItem: item({ variants: connection([variant("3")]) }),
        }),
      )
      .mockResolvedValueOnce(
        inventoryResponse([
          level({
            id: "gid://shopify/InventoryLevel/4?inventory_item_id=9",
            item: item({
              id: "gid://shopify/InventoryItem/9",
              sku: null,
              variants: null,
            }),
          }),
        ]),
      );
    const result = await service.getInventoryLevels(locationGid);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      shopDomain: "fixture.myshopify.com",
      locationGid,
      inventoryItemGid: itemGid,
      inventoryLevelGid: levelGid,
      sku: "SKU",
      availableQuantity: 5,
      shopifyUpdatedAt: new Date("2026-11-01T01:00:00Z"),
      variants: ["1", "2", "3"].map((id) => ({
        variantGid: `gid://shopify/ProductVariant/${id}`,
        variantTitle: `Variant ${id}`,
        productGid: "gid://shopify/Product/1",
        productTitle: "Product",
      })),
    });
    expect(result[1]).toMatchObject({ sku: null, variants: [] });
    expect(graphql).toHaveBeenNthCalledWith(1, LOCATION_INVENTORY_QUERY, {
      variables: { locationId: locationGid, first: 25, after: null },
      tries: 1,
    });
    expect(graphql).toHaveBeenNthCalledWith(2, INVENTORY_ITEM_QUERY, {
      variables: { id: itemGid, first: 50, after: "variant-1" },
      tries: 1,
    });
    expect(graphql).toHaveBeenNthCalledWith(3, INVENTORY_ITEM_QUERY, {
      variables: { id: itemGid, first: 50, after: "variant-2" },
      tries: 1,
    });
    expect(graphql).toHaveBeenNthCalledWith(4, LOCATION_INVENTORY_QUERY, {
      variables: { locationId: locationGid, first: 25, after: "level-next" },
      tries: 1,
    });
  });

  it("gets an inventory item with every variant page", async () => {
    const { graphql, service } = setup();
    graphql
      .mockResolvedValueOnce(
        response({
          inventoryItem: item({ variants: connection([variant()], "next") }),
        }),
      )
      .mockResolvedValueOnce(
        response({
          inventoryItem: item({ variants: connection([variant("2")]) }),
        }),
      );
    expect(await service.getInventoryItem(itemGid)).toMatchObject({
      inventoryItemGid: itemGid,
      tracked: true,
      variants: [{ variantTitle: "Variant 1" }, { variantTitle: "Variant 2" }],
    });
  });

  it("returns null for a missing item and an empty variants list for a nullable connection", async () => {
    const { graphql, service } = setup();
    graphql
      .mockResolvedValueOnce(response({ inventoryItem: null }))
      .mockResolvedValueOnce(
        response({
          inventoryItem: item({ variants: null, sku: null, tracked: false }),
        }),
      );
    expect(await service.getInventoryItem(itemGid)).toBeNull();
    expect(await service.getInventoryItem(itemGid)).toEqual({
      inventoryItemGid: itemGid,
      sku: null,
      tracked: false,
      variants: [],
    });
  });

  it("skips inactive/untracked/missing available instead of inventing zero; keeps zero and negative quantities", async () => {
    const { graphql, service } = setup();
    graphql.mockResolvedValueOnce(
      inventoryResponse([
        level({ isActive: false }),
        level({ item: item({ tracked: false }) }),
        level({ quantities: [] }),
        level({ quantities: [{ name: "on_hand", quantity: 20 }] }),
        level({ quantities: [{ name: "available", quantity: null }] }),
        level({ quantities: [{ name: "available", quantity: 0 }] }),
        level({
          id: "gid://shopify/InventoryLevel/4?inventory_item_id=9",
          item: item({ id: "gid://shopify/InventoryItem/9" }),
          quantities: [{ name: "available", quantity: -3 }],
        }),
      ]),
    );
    expect(
      (await service.getInventoryLevels(locationGid)).map(
        (row) => row.availableQuantity,
      ),
    ).toEqual([0, -3]);
  });

  it("accepts an empty successful inventory page", async () => {
    const { graphql, service } = setup();
    graphql.mockResolvedValueOnce(inventoryResponse([]));
    expect(await service.getInventoryLevels(locationGid)).toEqual([]);
  });

  it("rejects overlapping inventory pages instead of returning duplicate item snapshots", async () => {
    const { graphql, service } = setup();
    graphql
      .mockResolvedValueOnce(inventoryResponse([level()], "next"))
      .mockResolvedValueOnce(inventoryResponse([level()]));
    await expect(service.getInventoryLevels(locationGid)).rejects.toThrow(
      "Inventory item repeated",
    );
  });

  it.each([
    null,
    { id: locationGid, isActive: false },
    { id: "other", isActive: true },
  ])("rejects an unavailable or mismatched location: %j", async (location) => {
    const { graphql, service } = setup();
    graphql.mockResolvedValueOnce(response({ location }));
    await expect(service.getInventoryLevels(locationGid)).rejects.toMatchObject(
      { code: "LOCATION_UNAVAILABLE" },
    );
  });

  it.each([null, { variants: null }])(
    "fails if an item or variants disappear mid-pagination: %j",
    async (change) => {
      const { graphql, service } = setup();
      graphql
        .mockResolvedValueOnce(
          inventoryResponse([
            level({
              item: item({ variants: connection([variant()], "next") }),
            }),
          ]),
        )
        .mockResolvedValueOnce(
          response({ inventoryItem: change ? item(change) : null }),
        );
      await expect(service.getInventoryLevels(locationGid)).rejects.toThrow(
        "disappeared",
      );
    },
  );

  it.each([
    { updatedAt: "invalid" },
    { quantities: [{ name: "available", quantity: 0.5 }] },
  ])("rejects invalid snapshot fields: %j", async (change) => {
    const { graphql, service } = setup();
    graphql.mockResolvedValueOnce(inventoryResponse([level(change)]));
    await expect(service.getInventoryLevels(locationGid)).rejects.toThrow(
      "invalid quantity or updatedAt",
    );
  });

  it("does not return partial inventory when a later page fails", async () => {
    const { graphql, service } = setup();
    graphql
      .mockResolvedValueOnce(inventoryResponse([level()], "next"))
      .mockResolvedValueOnce(
        response(null, {
          errors: [
            { message: "Access denied", extensions: { code: "ACCESS_DENIED" } },
          ],
        }),
      );
    await expect(service.getInventoryLevels(locationGid)).rejects.toMatchObject(
      { code: "ACCESS_DENIED" },
    );
  });
});

describe("GraphQL failures and pagination guards", () => {
  it.each([null, {}])("rejects null or missing root data: %j", async (data) => {
    const { graphql, service } = setup();
    graphql.mockResolvedValueOnce(response(data));
    await expect(service.getLocations()).rejects.toBeInstanceOf(
      ShopifyGraphqlError,
    );
  });

  it("rejects GraphQL errors even when partial data exists", async () => {
    const { graphql, service } = setup();
    graphql.mockResolvedValueOnce(
      response(
        { locations: connection([]) },
        {
          errors: [
            {
              message: "Forbidden field",
              extensions: { code: "ACCESS_DENIED" },
            },
          ],
        },
      ),
    );
    await expect(service.getLocations()).rejects.toMatchObject({
      message: "Forbidden field",
      code: "ACCESS_DENIED",
    });
    expect(graphql).toHaveBeenCalledTimes(1);
  });

  it("handles the official SDK's thrown GraphqlQueryError", async () => {
    const { graphql, service } = setup();
    graphql.mockRejectedValueOnce(
      new GraphqlQueryError({
        message: "upstream",
        response: {},
        body: { errors: { graphQLErrors: [{ message: "Bad field" }] } },
      }),
    );
    await expect(service.getLocations()).rejects.toMatchObject({
      message: "Bad field",
      code: "GRAPHQL_ERROR",
    });
  });

  it("rejects malformed JSON and transport failures without returning an empty success", async () => {
    const { graphql, service } = setup();
    graphql
      .mockResolvedValueOnce(new Response("not json"))
      .mockRejectedValueOnce(new TypeError("Network down"));
    await expect(service.getLocations()).rejects.toBeInstanceOf(SyntaxError);
    await expect(service.getLocations()).rejects.toThrow("Network down");
  });

  it.each([401, 403, 302])(
    "preserves auth/permission Responses unchanged: %i",
    async (status) => {
      const { graphql, service } = setup();
      const error = new Response(null, {
        status,
        headers: { "X-Shopify-API-Request-Failure-Reauthorize": "1" },
      });
      graphql.mockRejectedValueOnce(error);
      await expect(service.getLocations()).rejects.toBe(error);
      expect(graphql).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["locations", "levels", "variants"])(
    "rejects repeated cursors in %s",
    async (kind) => {
      const { graphql, service } = setup();
      const page =
        kind === "locations"
          ? response({ locations: connection([], "same") })
          : kind === "levels"
            ? inventoryResponse([], "same")
            : response({
                inventoryItem: item({
                  variants: connection([variant()], "same"),
                }),
              });
      graphql.mockImplementation(async () => page.clone());
      const operation =
        kind === "locations"
          ? service.getLocations()
          : kind === "levels"
            ? service.getInventoryLevels(locationGid)
            : service.getInventoryItem(itemGid);
      await expect(operation).rejects.toThrow("pagination cursor");
      expect(graphql).toHaveBeenCalledTimes(2);
    },
  );

  it("rejects hasNextPage without a cursor", async () => {
    const { graphql, service } = setup();
    graphql.mockResolvedValueOnce(
      response({
        locations: {
          nodes: [],
          pageInfo: { hasNextPage: true, endCursor: null },
        },
      }),
    );
    await expect(service.getLocations()).rejects.toThrow("pagination cursor");
  });

  it("rejects missing pageInfo instead of truncating results", async () => {
    const { graphql, service } = setup();
    graphql.mockResolvedValueOnce(response({ locations: { nodes: [] } }));
    await expect(service.getLocations()).rejects.toThrow(
      "pagination information",
    );
  });
});

describe("bounded rate-limit and HTTP retries", () => {
  it("retries a returned non-OK HTTP response and then recovers", async () => {
    vi.useFakeTimers();
    const { graphql, service } = setup();
    graphql
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(response({ locations: connection([]) }));
    const pending = service.getLocations();
    await vi.runAllTimersAsync();
    expect(await pending).toEqual([]);
    expect(graphql).toHaveBeenCalledTimes(2);
  });

  it("honors GraphQL cost/restoreRate for thrown SDK throttling", async () => {
    vi.useFakeTimers();
    const { graphql, service } = setup();
    graphql
      .mockRejectedValueOnce(
        new GraphqlQueryError({
          message: "Throttled",
          response: {},
          body: {
            errors: {
              graphQLErrors: [
                { message: "Throttled", extensions: { code: "THROTTLED" } },
              ],
            },
            extensions: {
              cost: {
                requestedQueryCost: 250,
                throttleStatus: { currentlyAvailable: 50, restoreRate: 50 },
              },
            },
          },
        }),
      )
      .mockResolvedValueOnce(response({ locations: connection([]) }));
    const pending = service.getLocations();
    await vi.advanceTimersByTimeAsync(3999);
    expect(graphql).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual([]);
    expect(graphql).toHaveBeenCalledTimes(2);
  });

  it.each(["seconds", "date", "sdk"])(
    "honors HTTP 429 Retry-After (%s)",
    async (kind) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-11-01T00:00:00Z"));
      const { graphql, service } = setup();
      const error =
        kind === "sdk"
          ? new HttpResponseError({
              message: "Throttled",
              code: 429,
              statusText: "Too Many Requests",
              headers: { "Retry-After": "3" },
            })
          : new Response(null, {
              status: 429,
              headers: {
                "Retry-After":
                  kind === "seconds" ? "3" : "Sun, 01 Nov 2026 00:00:03 GMT",
              },
            });
      graphql
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce(response({ locations: connection([]) }));
      const pending = service.getLocations();
      await vi.advanceTimersByTimeAsync(2999);
      expect(graphql).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toEqual([]);
    },
  );

  it.each([429, 503])(
    "limits HTTP %i to three attempts with fallback backoff",
    async (status) => {
      vi.useFakeTimers();
      const { graphql, service } = setup();
      const error = new Response(null, { status });
      graphql.mockRejectedValue(error);
      const checked = expect(service.getLocations()).rejects.toBe(error);
      await vi.runAllTimersAsync();
      await checked;
      expect(graphql).toHaveBeenCalledTimes(3);
    },
  );

  it("limits HTTP-200 THROTTLED errors to three attempts", async () => {
    vi.useFakeTimers();
    const { graphql, service } = setup();
    graphql.mockImplementation(async () =>
      response(null, {
        errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
      }),
    );
    const checked = expect(service.getLocations()).rejects.toMatchObject({
      code: "THROTTLED",
    });
    await vi.runAllTimersAsync();
    await checked;
    expect(graphql).toHaveBeenCalledTimes(3);
  });
});
