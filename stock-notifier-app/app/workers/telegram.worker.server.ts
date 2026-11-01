import { setTimeout } from "node:timers/promises";
import { loadEnv } from "vite";

const environmentKeys = [
  "DATABASE_URL",
  "TELEGRAM_BOT_TOKEN",
  "SHOPIFY_API_KEY",
  "SHOPIFY_API_SECRET",
  "SHOPIFY_APP_URL",
  "SCOPES",
  "SHOP_CUSTOM_DOMAIN",
];
// Capture before loadEnv: dotenv expansion can replace explicit empty overrides.
const overrides = Object.fromEntries(
  environmentKeys.map((key) => [key, process.env[key]]),
);
const localEnv = loadEnv("development", process.cwd(), "");
for (const key of environmentKeys) {
  const value = overrides[key] ?? localEnv[key];
  if (value !== undefined) process.env[key] = value;
}
const inventoryMode = process.argv.includes("--inventory");
const missingShopify = inventoryMode
  ? ["SHOPIFY_API_KEY", "SHOPIFY_API_SECRET", "SHOPIFY_APP_URL"].filter(
      (key) => !process.env[key]?.trim(),
    )
  : [];
let validAppUrl = true;
if (inventoryMode && !missingShopify.includes("SHOPIFY_APP_URL")) {
  try {
    validAppUrl = ["https:", "http:"].includes(
      new URL(process.env.SHOPIFY_APP_URL!).protocol,
    );
  } catch {
    validAppUrl = false;
  }
}

if (missingShopify.length || !validAppUrl) {
  console.error(
    missingShopify.length
      ? `Inventory worker configuration missing: ${missingShopify.join(", ")}.`
      : "Inventory worker requires a valid http(s) SHOPIFY_APP_URL.",
  );
  console.error(
    "Set these in stock-notifier-app/.env for the same Shopify app as npm run dev. Copy the current HTTPS tunnel URL from the dev terminal into SHOPIFY_APP_URL; CLI variables are not shared with this terminal. See README Phase M2.",
  );
  process.exitCode = 1;
} else if (!inventoryMode && !process.env.TELEGRAM_BOT_TOKEN?.trim()) {
  console.error(
    "Configure TELEGRAM_BOT_TOKEN before starting the Telegram worker.",
  );
  process.exitCode = 1;
} else {
  // Load Prisma after .env expansion; this worker never receives Shopify request credentials.
  const { default: db } = await import("../db.server");
  const { processNotificationForShop } =
    await import("../modules/notifications/notification-worker.server");
  const inventory = inventoryMode
    ? await import("../modules/inventory/inventory-background.server")
    : null;
  let stopping = false;
  process.once("SIGINT", () => {
    stopping = true;
  });
  process.once("SIGTERM", () => {
    stopping = true;
  });
  console.info(
    inventoryMode
      ? "Inventory worker started; discovery/sync every 60 seconds."
      : "Telegram worker started; polling PostgreSQL.",
  );
  try {
    while (!stopping) {
      try {
        if (inventory) await inventory.syncInstalledShops(() => stopping);
        else {
          const shops = await db.shopSettings.findMany({
            where: { telegramChatId: { not: null } },
            select: { shopDomain: true },
          });
          for (const shop of shops) {
            if (stopping) break;
            await processNotificationForShop(shop.shopDomain);
          }
        }
      } catch {
        console.error("Local worker failure; retrying on the next poll.");
      }
      if (!stopping) await setTimeout(inventoryMode ? 60000 : 1000);
    }
  } finally {
    await db.$disconnect();
  }
}
