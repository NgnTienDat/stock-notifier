import type { ActionFunctionArgs, HeadersFunction } from "react-router";
import { data } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  InventorySyncError,
  syncInventory,
} from "../modules/inventory/inventory-sync.service.server";

export async function action({ request }: ActionFunctionArgs) {
  const context = await authenticate.admin(request);
  try {
    return data({ result: await syncInventory(context), error: null });
  } catch (error) {
    if (
      error instanceof Response &&
      (error.status === 401 || (error.status >= 300 && error.status < 400))
    )
      throw error;
    return data(
      {
        result: null,
        error:
          error instanceof InventorySyncError
            ? error.message
            : "Inventory sync failed. Previous inventory was kept. Please try again.",
      },
      { status: error instanceof InventorySyncError ? error.status : 503 },
    );
  }
}

export const headers: HeadersFunction = (args) => boundary.headers(args);
