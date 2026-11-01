import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import {
  data,
  useFetchers,
  useLoaderData,
  useNavigation,
  useRevalidator,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { createShopifyGraphqlService } from "../modules/shopify/graphql/shopify-graphql.server";
import { getLocationSettings } from "../modules/settings/settings.repository.server";
import {
  InvalidLocationError,
  selectLocation,
} from "../modules/settings/settings.service.server";

import { InventorySync } from "../modules/inventory/inventory-sync";
import { ThresholdSettings } from "../modules/settings/threshold-settings";
import { TelegramSettings } from "../modules/settings/telegram-settings";
import type { LocationData } from "../modules/shopify/graphql/types";

function preserveAuthenticationResponse(error: unknown) {
  if (
    error instanceof Response &&
    (error.status === 401 || (error.status >= 300 && error.status < 400))
  )
    throw error;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const context = await authenticate.admin(request);
  const selected = await getLocationSettings(context.session.shop);
  try {
    const locations = await createShopifyGraphqlService(context).getLocations();
    return {
      selected,
      locations,
      error: null,
      botConfigured: Boolean(process.env.TELEGRAM_BOT_TOKEN?.trim()),
    };
  } catch (error) {
    preserveAuthenticationResponse(error);
    return {
      selected,
      botConfigured: Boolean(process.env.TELEGRAM_BOT_TOKEN?.trim()),
      locations: [] as LocationData[],
      error: "Could not load locations from Shopify. Please try again.",
    };
  }
}

export async function action({ request }: ActionFunctionArgs) {
  const context = await authenticate.admin(request);
  const form = await request.formData();
  const values = form.getAll("locationGid");
  const locationGid = values[0];
  if (
    values.length !== 1 ||
    typeof locationGid !== "string" ||
    !locationGid.trim()
  ) {
    return data(
      { saved: false, error: "Choose one location." },
      { status: 400 },
    );
  }
  try {
    await selectLocation(context, locationGid);
    return data({ saved: true, error: null });
  } catch (error) {
    preserveAuthenticationResponse(error);
    if (error instanceof InvalidLocationError)
      return data({ saved: false, error: error.message }, { status: 400 });
    return data(
      { saved: false, error: "Could not save location. Please try again." },
      { status: 503 },
    );
  }
}

export default function Settings() {
  const { selected, locations, error, botConfigured } =
    useLoaderData<typeof loader>();

  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const fetchers = useFetchers();
  const busy =
    navigation.state !== "idle" ||
    revalidator.state !== "idle" ||
    fetchers.some((fetcher) => fetcher.state !== "idle");

  return (
    <s-page heading="StockPulse settings">
      <s-section heading="Automatic location monitoring">
        <s-paragraph>
          All active Shopify locations are monitored automatically. Start the
          inventory worker for background discovery and sync, or use Sync now.
        </s-paragraph>
        {error && (
          <s-banner heading="Locations could not be loaded" tone="critical">
            {error}
          </s-banner>
        )}
        <s-paragraph>{locations.length} active Shopify locations.</s-paragraph>
      </s-section>
      <ThresholdSettings
        threshold={selected?.lowStockThreshold ?? 5}
        busy={busy}
      />
      <InventorySync busy={busy} />
      <TelegramSettings
        chatId={selected?.telegramChatId ?? null}
        botConfigured={botConfigured}
        busy={busy}
      />
    </s-page>
  );
}

export const headers: HeadersFunction = (args) => boundary.headers(args);
