import type { ActionFunctionArgs, HeadersFunction } from "react-router";
import { data } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  saveTelegramSettings,
  testTelegramSettings,
} from "../modules/notifications/telegram-settings.service.server";
import { TelegramError } from "../modules/notifications/telegram.server";

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const intents = form.getAll("intent");
  const intent = intents.length === 1 ? intents[0] : null;
  if (intent !== "save" && intent !== "test")
    return data(
      { message: null, error: "Invalid Telegram action." },
      { status: 400 },
    );
  try {
    if (intent === "save") {
      const values = form.getAll("telegramChatId");
      await saveTelegramSettings(
        session.shop,
        values.length === 1 ? values[0] : null,
      );
    } else {
      await testTelegramSettings(session.shop);
    }
    return data({
      message:
        intent === "save"
          ? "Telegram settings saved."
          : "Telegram accepted the test message.",
      error: null,
    });
  } catch (error) {
    return data(
      {
        message: null,
        error:
          error instanceof TelegramError
            ? error.message
            : "Could not update Telegram. Please try again.",
      },
      {
        status: error instanceof TelegramError && !error.retryable ? 400 : 503,
      },
    );
  }
}
export const headers: HeadersFunction = (args) => boundary.headers(args);
