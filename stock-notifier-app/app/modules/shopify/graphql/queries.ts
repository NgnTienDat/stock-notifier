export const LOCATIONS_QUERY = `#graphql
  query StockPulseLocations($first: Int!, $after: String) {
    locations(first: $first, after: $after, includeInactive: false) {
      nodes { id name isActive }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

export const LOCATION_QUERY = `#graphql
  query StockPulseLocation($locationId: ID!) {
    location(id: $locationId) { id name isActive }
  }
`;

export const LOCATION_INVENTORY_QUERY = `#graphql
  query StockPulseLocationInventory($locationId: ID!, $first: Int!, $after: String) {
    location(id: $locationId) {
      id
      isActive
      inventoryLevels(first: $first, after: $after, includeInactive: false) {
        nodes {
          id
          isActive
          updatedAt
          quantities(names: ["available"]) { name quantity }
          item {
            id
            sku
            tracked
            variants(first: 10) {
              nodes { id title product { id title } }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

export const INVENTORY_ITEM_QUERY = `#graphql
  query StockPulseInventoryItem($id: ID!, $first: Int!, $after: String) {
    inventoryItem(id: $id) {
      id
      sku
      tracked
      variants(first: $first, after: $after) {
        nodes { id title product { id title } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

export const INVENTORY_LEVEL_QUERY = `#graphql
  query StockPulseInventoryLevel($itemId: ID!, $locationId: ID!) {
    location(id: $locationId) { id isActive }
    inventoryItem(id: $itemId) {
      id sku tracked
      variants(first: 10) {
        nodes { id title product { id title } }
        pageInfo { hasNextPage endCursor }
      }
      inventoryLevel(locationId: $locationId, includeInactive: true) {
        id isActive updatedAt
        quantities(names: ["available"]) { name quantity }
      }
    }
  }
`;
