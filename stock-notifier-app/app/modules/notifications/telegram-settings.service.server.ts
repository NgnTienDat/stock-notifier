import {
  getLocationSettings,
  saveTelegramChatId,
} from "../settings/settings.repository.server";
import {
  parseTelegramChatId,
  sendTelegramMessage,
  TelegramError,
} from "./telegram.server";

export async function saveTelegramSettings(shopDomain: string, value: unknown) {
  await saveTelegramChatId(shopDomain, parseTelegramChatId(value));
}

export async function testTelegramSettings(shopDomain: string) {
  const settings = await getLocationSettings(shopDomain);
  if (!settings?.telegramChatId)
    throw new TelegramError(
      "Save a Telegram Chat ID before sending a test message.",
    );
  await sendTelegramMessage(
    settings.telegramChatId,
    "StockPulse test message: your Telegram notifications are connected.",
  );
}
