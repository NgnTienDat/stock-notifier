import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  InvalidInventoryWebhookError,
  decodeInventoryWebhookBody,
  processInventoryWebhook,
} from "../modules/inventory/inventory-webhook.service.server";

export async function action({ request }: ActionFunctionArgs) {
  const body = request.clone();
  // Preserve the template's HMAC rejection Responses before any business/database work.
  const context = await authenticate.webhook(request);
  try {
    const result = await processInventoryWebhook(
      {
        ...context,
        payload: decodeInventoryWebhookBody(await body.text()),
      },
      request.headers.get("X-Shopify-Event-Id"),
    );
    console.info("Inventory webhook", {
      shop: context.shop,
      topic: context.topic,
      webhookId: context.webhookId,
      result,
    });
    return new Response(null, { status: 200 });
  } catch (error) {
    if (
      error instanceof InvalidInventoryWebhookError ||
      error instanceof SyntaxError
    )
      return new Response("Invalid inventory webhook", { status: 400 });
    console.error("Inventory webhook retry required", {
      shop: context.shop,
      webhookId: context.webhookId,
      reason: "Durable webhook enqueue failed",
    });
    return new Response("Inventory processing failed; retry required", {
      status: 503,
    });
  }
}
