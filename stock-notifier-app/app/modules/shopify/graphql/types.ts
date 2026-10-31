import type { InventoryLevel } from "@prisma/client";

export type VariantMetadata = {
  variantGid: string;
  variantTitle: string;
  productGid: string;
  productTitle: string;
};

export type InventoryItemData = {
  inventoryItemGid: string;
  sku: string | null;
  tracked: boolean;
  variants: VariantMetadata[];
};

export type LocationData = { locationGid: string; locationName: string };

// Prisma's id is app-owned; the opaque Shopify level GID is a separate read field.
export type InventoryLevelData = Pick<
  InventoryLevel,
  | "shopDomain"
  | "locationGid"
  | "inventoryItemGid"
  | "sku"
  | "availableQuantity"
  | "shopifyUpdatedAt"
> & {
  inventoryLevelGid: string;
  variants: VariantMetadata[];
};

export type PageInfo = { hasNextPage: boolean; endCursor: string | null };
export type Connection<T> = { nodes: T[]; pageInfo: PageInfo };
export type VariantNode = {
  id: string;
  title: string;
  product: { id: string; title: string };
};
export type InventoryItemNode = {
  id: string;
  sku: string | null;
  tracked: boolean;
  variants: Connection<VariantNode> | null;
};
export type InventoryLevelNode = {
  id: string;
  isActive: boolean;
  updatedAt: string;
  quantities: { name: string; quantity: number | null }[];
  item: InventoryItemNode;
};
export type LocationsResponse = {
  locations: Connection<{ id: string; name: string; isActive: boolean }>;
};
export type LocationInventoryResponse = {
  location: {
    id: string;
    isActive: boolean;
    inventoryLevels: Connection<InventoryLevelNode>;
  } | null;
};
export type InventoryItemResponse = { inventoryItem: InventoryItemNode | null };

export type GraphqlEnvelope<T> = {
  data?: T | null;
  errors?: { message: string; extensions?: { code?: string } }[];
  extensions?: {
    cost?: {
      requestedQueryCost?: number;
      throttleStatus?: { currentlyAvailable: number; restoreRate: number };
    };
  };
};
