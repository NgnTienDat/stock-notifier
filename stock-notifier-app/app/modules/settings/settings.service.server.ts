import type { AdminContext } from "@shopify/shopify-app-react-router/server";
import { createShopifyGraphqlService } from "../shopify/graphql/shopify-graphql.server";
import { saveLocationSettings } from "./settings.repository.server";

export class InvalidLocationError extends Error {}

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
