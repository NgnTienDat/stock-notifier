import { env } from "node:process";
import { createAdminApiClient } from "@shopify/admin-api-client";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import { ApiVersion } from "@shopify/shopify-app-react-router/server";
import type { LoaderFunctionArgs } from "react-router";
import type { AdminGraphqlClient } from "@shopify/shopify-app-react-router/server";
import { afterAll, expect, test, vi } from "vitest";
import db from "../app/db.server";
import { authenticate } from "../app/shopify.server";
import { loader } from "../app/routes/app.settings";
import { createShopifyGraphqlService } from "../app/modules/shopify/graphql/shopify-graphql.server";

vi.mock("../app/shopify.server", () => ({ authenticate: { admin: vi.fn() } }));
afterAll(() => db.$disconnect());

// Opt-in, read-only probe: live Shopify + PostgreSQL, with stored offline auth context.
test.skipIf(env.SHOPIFY_LIVE_TEST !== "1")(
  "settings loader and inventory-level service read live Shopify using the saved offline session",
  async () => {
    const stored = await db.session.findFirst({
      where: { isOnline: false },
      orderBy: { expires: "desc" },
      select: { id: true },
    });
    if (!stored)
      throw new Error(
        "No offline Shopify session; open the app in Shopify Admin first.",
      );
    const session = await new PrismaSessionStorage(db).loadSession(stored.id);
    if (!session?.accessToken)
      throw new Error("Stored Shopify session has no access token.");
    const client = createAdminApiClient({
      storeDomain: session.shop,
      apiVersion: ApiVersion.July26,
      accessToken: session.accessToken,
    });
    const context = {
      admin: { graphql: client.fetch as AdminGraphqlClient },
      session,
    };
    vi.mocked(authenticate.admin).mockResolvedValue(
      context as unknown as Awaited<ReturnType<typeof authenticate.admin>>,
    );
    try {
      const view = await loader({
        request: new Request("https://app.test/app/settings"),
        params: {},
        context: {},
      } as LoaderFunctionArgs);
      expect(view.error).toBeNull();
      expect(Array.isArray(view.locations)).toBe(true);
      const settings = await db.shopSettings.findUnique({
        where: { shopDomain: session.shop },
      });
      const saved = settings?.locationGid
        ? await db.inventoryLevel.findFirst({
            where: {
              shopDomain: session.shop,
              locationGid: settings.locationGid,
              isCurrent: true,
            },
            select: { locationGid: true, inventoryItemGid: true },
          })
        : null;
      if (!saved)
        throw new Error(
          "Select a location and run initial sync before the inventory live probe.",
        );
      const level = await createShopifyGraphqlService(
        context,
      ).getInventoryLevel(saved.locationGid, saved.inventoryItemGid);
      expect(level?.inventoryItemGid).toBe(saved.inventoryItemGid);
      expect(level?.inventoryLevelGid).toContain("?inventory_item_id=");
    } catch (error) {
      if (error instanceof Response)
        throw new Error(
          `Live Shopify loader returned HTTP ${error.status}; refresh the app session in Shopify Admin.`,
        );
      throw error;
    }
  },
  30000,
);
