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
    const values = (await request.formData()).getAll("retryLocationGid");
    if (
      values.length > 1 ||
      (values.length === 1 &&
        (typeof values[0] !== "string" || !values[0].trim()))
    )
      return data(
        { result: null, error: "Invalid retry location." },
        { status: 400 },
      );
    return data({
      result: await syncInventory(context, values[0] as string | undefined),
      error: null,
    });
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
