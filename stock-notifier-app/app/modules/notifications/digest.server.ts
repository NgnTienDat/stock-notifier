import {
  claimDigest,
  readDigest,
  finishDigest,
} from "./digest.repository.server";
import { sendTelegramMessage, TelegramError } from "./telegram.server";
import { formatDigest } from "./digest-format";

export async function processDigestForShop(shopDomain: string) {
  if (!process.env.TELEGRAM_BOT_TOKEN?.trim()) return false;
  const claim = await claimDigest(shopDomain);
  if (!claim) return false;
  const data = await readDigest(claim);
  if (!data?.alerts.length) {
    await finishDigest(claim, { cancelled: true });
    return true;
  }
  const text = formatDigest(claim, data);
  try {
    await sendTelegramMessage(claim.chatId, text);
  } catch (error) {
    await finishDigest(claim, {
      text,
      failure:
        error instanceof TelegramError
          ? error
          : new TelegramError("Digest delivery failed.", true),
    });
    return true;
  }
  await finishDigest(claim, { text, alertIds: data.alerts.map((a) => a.id) });
  return true;
}
