import { GraphqlQueryError, HttpResponseError } from "@shopify/shopify-api";
import type { AdminContext } from "@shopify/shopify-app-react-router/server";
import {
  INVENTORY_ITEM_QUERY,
  INVENTORY_LEVEL_QUERY,
  LOCATION_INVENTORY_QUERY,
  LOCATIONS_QUERY,
} from "./queries";
import type {
  GraphqlEnvelope,
  InventoryItemData,
  InventoryItemNode,
  InventoryItemResponse,
  InventoryLevelData,
  InventoryLevelResponse,
  LocationData,
  LocationInventoryResponse,
  LocationsResponse,
  PageInfo,
} from "./types";

const sleep = (milliseconds: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    signal?.throwIfAborted();
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

export class ShopifyGraphqlError extends Error {
  constructor(
    message: string,
    readonly code = "INVALID_RESPONSE",
  ) {
    super(message);
    this.name = "ShopifyGraphqlError";
  }
}

function nextCursor(pageInfo: PageInfo, seen: Set<string>): string | null {
  if (!pageInfo || typeof pageInfo.hasNextPage !== "boolean") {
    throw new ShopifyGraphqlError(
      "Shopify returned missing pagination information",
    );
  }
  if (!pageInfo.hasNextPage) return null;
  const cursor = pageInfo.endCursor;
  if (!cursor || seen.has(cursor)) {
    throw new ShopifyGraphqlError(
      "Shopify returned missing or repeated pagination cursor",
    );
  }
  seen.add(cursor);
  return cursor;
}

function retryDelay(
  attempt: number,
  retryAfter?: string | number | null,
): number {
  if (retryAfter != null) {
    const seconds = Number(retryAfter);
    const delay = Number.isFinite(seconds)
      ? seconds * 1000
      : Date.parse(String(retryAfter)) - Date.now();
    if (Number.isFinite(delay) && delay > 0) return delay;
  }
  return 1000 * 2 ** attempt;
}

/** Reuse the authenticated admin/webhook context; no new auth or DB client. */
export function createShopifyGraphqlService(
  { admin, session }: Pick<AdminContext, "admin" | "session">,
  options: {
    signal?: AbortSignal;
    maxRetries?: number;
    requireAvailable?: boolean;
  } = {},
) {
  async function query<T>(
    operation: string,
    variables: Record<string, string | number | null>,
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      options.signal?.throwIfAborted();
      let payload: GraphqlEnvelope<T>;
      try {
        const response = await admin.graphql(operation, {
          variables,
          tries: 1,
          ...(options.signal ? { signal: options.signal } : {}),
        });
        if (!response.ok) throw response;
        payload = (await response.json()) as GraphqlEnvelope<T>;
        options.signal?.throwIfAborted();
      } catch (error) {
        // The official client throws GraphqlQueryError for HTTP 200 GraphQL errors.
        if (error instanceof GraphqlQueryError) {
          payload = {
            errors: error.body?.errors?.graphQLErrors,
            extensions: error.body?.extensions,
          };
          if (!payload.errors?.length) throw error;
        } else {
          const status =
            error instanceof Response
              ? error.status
              : error instanceof HttpResponseError
                ? error.response.code
                : 0;
          if (
            (status === 429 || status >= 500) &&
            attempt < (options.maxRetries ?? 2)
          ) {
            const headers =
              error instanceof HttpResponseError
                ? error.response.headers
                : undefined;
            const value =
              error instanceof Response
                ? error.headers.get("Retry-After")
                : Object.entries(headers ?? {}).find(
                    ([key]) => key.toLowerCase() === "retry-after",
                  )?.[1];
            await sleep(
              retryDelay(attempt, value == null ? null : String(value)),
              options.signal,
            );
            continue;
          }
          // Preserve the template's authentication/reauthorization Responses unchanged.
          throw error;
        }
      }
      if (payload.errors?.length) {
        const throttled = payload.errors.every(
          (error) => error.extensions?.code === "THROTTLED",
        );
        if (throttled && attempt < (options.maxRetries ?? 2)) {
          const cost = payload.extensions?.cost;
          const throttle = cost?.throttleStatus;
          const needed =
            (cost?.requestedQueryCost ?? 0) -
            (throttle?.currentlyAvailable ?? 0);
          const costDelay =
            throttle && throttle.restoreRate > 0
              ? Math.ceil((needed / throttle.restoreRate) * 1000)
              : 0;
          await sleep(
            Math.max(
              retryDelay(attempt),
              Number.isFinite(costDelay) ? costDelay : 0,
            ),
            options.signal,
          );
          continue;
        }
        throw new ShopifyGraphqlError(
          payload.errors.map((error) => error.message).join("; "),
          payload.errors[0].extensions?.code ?? "GRAPHQL_ERROR",
        );
      }
      if (!payload.data)
        throw new ShopifyGraphqlError("Shopify returned null data");
      return payload.data;
    }
  }

  async function completeItem(
    item: InventoryItemNode,
  ): Promise<InventoryItemData> {
    const variants: InventoryItemData["variants"] = [];
    const seen = new Set<string>();
    let page = item.variants;
    while (page) {
      variants.push(
        ...page.nodes.map((variant) => ({
          variantGid: variant.id,
          variantTitle: variant.title,
          productGid: variant.product.id,
          productTitle: variant.product.title,
        })),
      );
      const after = nextCursor(page.pageInfo, seen);
      if (!after) break;
      const data = await query<InventoryItemResponse>(INVENTORY_ITEM_QUERY, {
        id: item.id,
        first: 50,
        after,
      });
      if (
        !data.inventoryItem ||
        data.inventoryItem.id !== item.id ||
        !data.inventoryItem.variants
      ) {
        throw new ShopifyGraphqlError(
          "Inventory item disappeared while reading variants",
        );
      }
      page = data.inventoryItem.variants;
    }
    return {
      inventoryItemGid: item.id,
      sku: item.sku,
      tracked: item.tracked,
      variants,
    };
  }

  async function getLocations(): Promise<LocationData[]> {
    const locations: LocationData[] = [];
    const seen = new Set<string>();
    let after: string | null = null;
    do {
      const data: LocationsResponse = await query(LOCATIONS_QUERY, {
        first: 50,
        after,
      });
      if (!data.locations)
        throw new ShopifyGraphqlError("Shopify returned null locations");
      if (
        data.locations.nodes.some(
          (location) =>
            typeof location.isActive !== "boolean" ||
            typeof location.id !== "string" ||
            typeof location.name !== "string",
        )
      )
        throw new ShopifyGraphqlError(
          "Shopify returned incomplete location metadata",
        );
      locations.push(
        ...data.locations.nodes
          .filter((location) => location.isActive)
          .map((location) => ({
            locationGid: location.id,
            locationName: location.name,
          })),
      );
      if (
        new Set(locations.map((location) => location.locationGid)).size !==
        locations.length
      )
        throw new ShopifyGraphqlError("Shopify returned duplicate locations");
      after = nextCursor(data.locations.pageInfo, seen);
    } while (after);
    return locations;
  }

  async function getInventoryItem(
    inventoryItemGid: string,
  ): Promise<InventoryItemData | null> {
    const data = await query<InventoryItemResponse>(INVENTORY_ITEM_QUERY, {
      id: inventoryItemGid,
      first: 50,
      after: null,
    });
    return data.inventoryItem ? completeItem(data.inventoryItem) : null;
  }

  async function getInventoryLevels(
    locationGid: string,
  ): Promise<InventoryLevelData[]> {
    const levels: InventoryLevelData[] = [];
    const seen = new Set<string>();
    const itemIds = new Set<string>();
    let after: string | null = null;
    do {
      // Keep the nested connection small to stay below Shopify's per-query cost limit.
      const data: LocationInventoryResponse = await query(
        LOCATION_INVENTORY_QUERY,
        {
          locationId: locationGid,
          first: 25,
          after,
        },
      );
      const location = data.location;
      if (
        !location ||
        location.id !== locationGid ||
        !location.isActive ||
        !location.inventoryLevels
      ) {
        throw new ShopifyGraphqlError(
          "Selected Shopify location is missing or inactive",
          "LOCATION_UNAVAILABLE",
        );
      }
      for (const level of location.inventoryLevels.nodes) {
        const quantity = level.quantities.find(
          (value) => value.name === "available",
        )?.quantity;
        if (
          level.isActive &&
          level.item.tracked &&
          quantity == null &&
          options.requireAvailable
        )
          throw new ShopifyGraphqlError(
            "Shopify omitted available quantity; retry scan.",
          );
        if (!level.isActive || !level.item.tracked || quantity == null)
          continue;
        const updatedAt = new Date(level.updatedAt);
        if (
          !Number.isInteger(quantity) ||
          !level.updatedAt ||
          Number.isNaN(updatedAt.getTime())
        ) {
          throw new ShopifyGraphqlError(
            "Shopify returned an invalid quantity or updatedAt",
          );
        }
        if (itemIds.has(level.item.id)) {
          throw new ShopifyGraphqlError(
            "Inventory item repeated during pagination; retry the read",
          );
        }
        itemIds.add(level.item.id);
        const item = await completeItem(level.item);
        levels.push({
          shopDomain: session.shop,
          locationGid,
          inventoryItemGid: item.inventoryItemGid,
          inventoryLevelGid: level.id,
          sku: item.sku,
          variants: item.variants,
          availableQuantity: quantity,
          shopifyUpdatedAt: updatedAt,
        });
      }
      after = nextCursor(location.inventoryLevels.pageInfo, seen);
    } while (after);
    return levels;
  }

  async function getInventoryLevel(
    locationGid: string,
    inventoryItemGid: string,
  ): Promise<InventoryLevelData | null> {
    const data = await query<InventoryLevelResponse>(INVENTORY_LEVEL_QUERY, {
      locationId: locationGid,
      itemId: inventoryItemGid,
    });
    if (
      data.location === undefined ||
      data.inventoryItem === undefined ||
      (data.inventoryItem && data.inventoryItem.inventoryLevel === undefined)
    ) {
      throw new ShopifyGraphqlError("Shopify omitted inventory read fields");
    }
    if (data.location && data.location.id !== locationGid)
      throw new ShopifyGraphqlError("Shopify returned a different location");
    const item = data.inventoryItem;
    if (item && item.id !== inventoryItemGid)
      throw new ShopifyGraphqlError(
        "Shopify returned a different inventory item",
      );
    const level = item?.inventoryLevel;
    if (!data.location?.isActive || !item?.tracked || !level?.isActive)
      return null;
    const quantity = level.quantities.find(
      (value) => value.name === "available",
    )?.quantity;
    const updatedAt = new Date(level.updatedAt);
    if (
      !Number.isInteger(quantity) ||
      quantity == null ||
      !level.updatedAt ||
      Number.isNaN(updatedAt.getTime())
    ) {
      throw new ShopifyGraphqlError(
        "Shopify returned an invalid quantity or updatedAt",
      );
    }
    const complete = await completeItem(item);
    return {
      shopDomain: session.shop,
      locationGid,
      inventoryItemGid,
      inventoryLevelGid: level.id,
      sku: complete.sku,
      variants: complete.variants,
      availableQuantity: quantity,
      shopifyUpdatedAt: updatedAt,
    };
  }

  return {
    getLocations,
    getInventoryLevels,
    getInventoryItem,
    getInventoryLevel,
  };
}
