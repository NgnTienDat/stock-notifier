import type { Prisma } from "@prisma/client";

export class TelegramError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
    readonly retryAfterMs = 0,
  ) {
    super(message);
    this.name = "TelegramError";
  }
}

export function parseTelegramChatId(value: unknown): string | null {
  if (typeof value !== "string")
    throw new TelegramError("Enter a numeric Telegram Chat ID.");
  const id = value.trim();
  if (!id) return null;
  if (
    !/^-?[1-9]\d{0,15}$/.test(id) ||
    BigInt(id) > 4503599627370495n ||
    BigInt(id) < -4503599627370495n
  ) {
    throw new TelegramError(
      "Enter a valid numeric Telegram Chat ID (negative IDs are allowed for groups).",
    );
  }
  return id;
}

function shorten(value: string, length: number) {
  return value.length <= length
    ? value
    : value.slice(0, length - 1).replace(/[\uD800-\uDBFF]$/, "") + "…";
}

export function formatInventoryNotification(input: {
  inventoryItemGid: string;
  variants: Prisma.JsonValue;
  sku: string | null;
  locationName: string | null | undefined;
  locationGid: string;
  quantity: number;
  threshold: number;
}) {
  const lines = [
    "Low stock — StockPulse",
    `Inventory Item: ${shorten(input.inventoryItemGid, 200)}`,
    `Location: ${shorten(input.locationName || input.locationGid, 200)}`,
    `SKU: ${shorten(input.sku || "N/A", 200)}`,
    `Available Quantity: ${input.quantity}`,
    `Threshold: ${input.threshold}`,
    "Products / Variants:",
  ];
  const variants = Array.isArray(input.variants) ? input.variants : [];
  const names = variants.map((variant) => {
    if (!variant || typeof variant !== "object" || Array.isArray(variant))
      return "Unknown product / variant";
    return `${typeof variant.productTitle === "string" ? variant.productTitle : "Unknown product"} / ${typeof variant.variantTitle === "string" ? variant.variantTitle : "Unknown variant"}`;
  });
  // Keep mandatory quantity/threshold fields before potentially lengthy variant metadata.
  return shorten(
    [...lines, names.length ? names.join("\n") : "Unavailable"].join("\n"),
    4096,
  );
}

// One attempt; the worker persists bounded retries instead of sleeping inside requests.
export async function sendTelegramMessage(chatId: string, text: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) throw new TelegramError("Telegram bot token is not configured.");
  let response: Response;
  let payload: {
    ok?: boolean;
    error_code?: number;
    parameters?: { retry_after?: number };
  };
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: shorten(text, 4096) }),
      signal: AbortSignal.timeout(2000),
      redirect: "error",
    });
    payload = await response.json();
  } catch {
    // Native fetch errors can contain the request URL (and thus the bot token).
    throw new TelegramError(
      "Telegram request timed out or could not be completed.",
      true,
    );
  }
  if (response.ok && payload?.ok === true) return;
  const code =
    response.status === 429 || response.status >= 500
      ? response.status
      : (payload?.error_code ?? response.status);
  const retryAfter = payload?.parameters?.retry_after;
  const retryAfterMs =
    Number.isSafeInteger(retryAfter) && retryAfter! > 0
      ? retryAfter! * 1000
      : 0;
  throw new TelegramError(
    code === 429
      ? "Telegram rate limit reached."
      : `Telegram rejected the message (code ${code}).`,
    code === 429 || code >= 500,
    retryAfterMs,
  );
}
