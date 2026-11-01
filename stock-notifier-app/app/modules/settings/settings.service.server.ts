import type { AdminContext } from "@shopify/shopify-app-react-router/server";
import { createShopifyGraphqlService } from "../shopify/graphql/shopify-graphql.server";
import {
  saveLocationSettings,
  saveLowStockThreshold,
} from "./settings.repository.server";

export class InvalidLocationError extends Error {}
export class InvalidThresholdError extends Error {}

export function parseLowStockThreshold(value: unknown) {
  const threshold =
    typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  if (!Number.isInteger(threshold) || threshold < 0 || threshold > 2147483647) {
    throw new InvalidThresholdError(
      "Enter a whole number between 0 and 2147483647.",
    );
  }
  return threshold;
}

export function changeLowStockThreshold(shopDomain: string, value: unknown) {
  return saveLowStockThreshold(shopDomain, parseLowStockThreshold(value));
}

export async function selectLocation(
  context: Pick<AdminContext, "admin" | "session">,
  locationGid: string,
) {
  const locations = await createShopifyGraphqlService(context).getLocations();
  const location = locations.find(
    (candidate) => candidate.locationGid === locationGid,
  );
  if (!location) {
    throw new InvalidLocationError(
      "Choose an active location from this store.",
    );
  }
  return saveLocationSettings(context.session.shop, location);
}
