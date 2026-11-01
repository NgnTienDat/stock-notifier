import {
  claimNotification,
  finishNotification,
  isNotificationEligible,
} from "./notification.repository.server";
import { sendTelegramMessage, TelegramError } from "./telegram.server";

export async function processNotificationForShop(shopDomain: string) {
  if (!process.env.TELEGRAM_BOT_TOKEN?.trim()) return false;
  const claim = await claimNotification(shopDomain);
  if (!claim) return false;
  if (!(await isNotificationEligible(shopDomain, claim))) {
    await finishNotification(shopDomain, claim, {
      message: "Notification no longer eligible.",
      retryable: false,
      retryAfterMs: 0,
    });
    return true;
  }
  try {
    await sendTelegramMessage(claim.chatId, claim.text);
  } catch (error) {
    const failure =
      error instanceof TelegramError
        ? error
        : new TelegramError("Telegram delivery failed.");
    await finishNotification(shopDomain, claim, failure);
    return true;
  }
  // A DB error here leaves the lease recoverable; never reinterpret an accepted send as an API failure.
  await finishNotification(shopDomain, claim);
  return true;
}
