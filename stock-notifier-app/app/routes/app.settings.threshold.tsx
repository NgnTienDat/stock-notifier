import type { ActionFunctionArgs, HeadersFunction } from "react-router";
import { data } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  changeLowStockThreshold,
  InvalidThresholdError,
} from "../modules/settings/settings.service.server";

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const values = form.getAll("lowStockThreshold");
  try {
    await changeLowStockThreshold(
      session.shop,
      values.length === 1 ? values[0] : null,
    );
    return data({ saved: true, error: null });
  } catch (error) {
    return data(
      {
        saved: false,
        error:
          error instanceof InvalidThresholdError
            ? error.message
            : "Could not save threshold. Please try again.",
      },
      { status: error instanceof InvalidThresholdError ? 400 : 503 },
    );
  }
}

export const headers: HeadersFunction = (args) => boundary.headers(args);
