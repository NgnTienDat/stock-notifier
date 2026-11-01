import { setTimeout } from "node:timers/promises";
import { loadEnv } from "vite";

// Preserve explicit overrides, including empty strings: dotenv expansion can replace them.
const databaseOverride = process.env.DATABASE_URL;
const tokenOverride = process.env.TELEGRAM_BOT_TOKEN;
const localEnv = loadEnv("development", process.cwd(), "");
process.env.DATABASE_URL = databaseOverride ?? localEnv.DATABASE_URL;
process.env.TELEGRAM_BOT_TOKEN = tokenOverride ?? localEnv.TELEGRAM_BOT_TOKEN;

if (!process.env.TELEGRAM_BOT_TOKEN?.trim()) {
  console.error(
    "Configure TELEGRAM_BOT_TOKEN before starting the Telegram worker.",
  );
  process.exitCode = 1;
} else {
  // Load Prisma after .env expansion; this worker never receives Shopify request credentials.
  const { default: db } = await import("../db.server");
  const { processNotificationForShop } =
    await import("../modules/notifications/notification-worker.server");
  let stopping = false;
  process.once("SIGINT", () => {
    stopping = true;
  });
  process.once("SIGTERM", () => {
    stopping = true;
  });
  console.info("Telegram worker started; polling PostgreSQL.");
  try {
    while (!stopping) {
      try {
        const shops = await db.shopSettings.findMany({
          where: { telegramChatId: { not: null } },
          select: { shopDomain: true },
        });
        for (const shop of shops) {
          if (stopping) break;
          await processNotificationForShop(shop.shopDomain);
        }
      } catch {
        console.error(
          "Telegram worker database failure; retrying on the next poll.",
        );
      }
      if (!stopping) await setTimeout(1000);
    }
  } finally {
    await db.$disconnect();
  }
}
