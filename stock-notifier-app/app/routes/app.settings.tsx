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
  useRouteLoaderData,
  useFetcher,
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
import type { loader as appLoader } from "./app";
import { discoverLocations } from "../modules/inventory/location-discovery.server";
import {
  LocationCards,
  MonitoringBanner,
  timestamp,
  DashboardErrorBoundary,
} from "../modules/dashboard/components";

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
  if (form.get("intent") === "refresh") {
    try {
      await discoverLocations(context);
      return data({ saved: true, error: null });
    } catch (error) {
      preserveAuthenticationResponse(error);
      return data(
        {
          saved: false,
          error: "Could not refresh locations. Previous data was kept.",
        },
        { status: 503 },
      );
    }
  }
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
  const app = useRouteLoaderData<typeof appLoader>("routes/app");
  const refresh = useFetcher<typeof action>();
  const revalidator = useRevalidator();
  const fetchers = useFetchers();
  const busy =
    navigation.state !== "idle" ||
    revalidator.state !== "idle" ||
    fetchers.some((fetcher) => fetcher.state !== "idle");

  return (
    <s-page heading="StockPulse settings" inlineSize="large">
      <s-link slot="breadcrumb-actions" href="/app">
        ← Back to dashboard
      </s-link>
      <div className="stockpulse">
        <p className="sp-intro">
          Store-wide threshold, automatic location discovery and Telegram
          configuration.
        </p>
        <div className="sp-block">
          <MonitoringBanner />
        </div>
        <div className="sp-settings">
          <div className="sp-settings-main">
            <ThresholdSettings
              threshold={selected?.lowStockThreshold ?? 5}
              busy={busy}
            />
            <s-section heading="Location monitoring">
              <div className="sp-panel-head">
                <p className="sp-secondary">
                  Read-only coverage. No manual selection is required.
                </p>
                <refresh.Form method="post">
                  <input type="hidden" name="intent" value="refresh" />
                  <s-button
                    type="submit"
                    loading={refresh.state !== "idle" || undefined}
                    disabled={busy || undefined}
                  >
                    Refresh locations
                  </s-button>
                </refresh.Form>
              </div>
              {error && (
                <s-banner
                  heading="Locations could not be loaded"
                  tone="critical"
                >
                  {error}
                </s-banner>
              )}
              {refresh.data?.error && (
                <s-banner heading="Refresh failed" tone="critical">
                  {refresh.data.error}
                </s-banner>
              )}
              <s-paragraph>
                {locations.length} active Shopify locations.
              </s-paragraph>
              <LocationCards locations={app?.coverage ?? []} />
            </s-section>
            <TelegramSettings
              chatId={selected?.telegramChatId ?? null}
              botConfigured={botConfigured}
              busy={busy}
            />
            <InventorySync busy={busy} />
          </div>
          <div className="sp-settings-aside">
            <s-section heading="How monitoring works">
              <s-unordered-list>
                <s-list-item>Discover all active Shopify locations</s-list-item>
                <s-list-item>Independent baseline per location</s-list-item>
                <s-list-item>Process inventory webhooks</s-list-item>
                <s-list-item>
                  Reconcile inventory through a background worker
                </s-list-item>
                <s-list-item>
                  Preserve history on location deactivation
                </s-list-item>
              </s-unordered-list>
              <s-paragraph>
                Switching the dashboard filter does not reset a baseline,
                resolve alerts or trigger a re-sync.
              </s-paragraph>
            </s-section>
            <s-section heading="Worker status">
              <s-paragraph>
                Process liveness is not reported. Run the inventory and Telegram
                workers in separate terminals.
              </s-paragraph>
              <s-paragraph>
                Latest recorded sync:{" "}
                {timestamp(
                  (app?.coverage ?? [])
                    .flatMap((l) =>
                      l.lastSyncedAt ? [new Date(l.lastSyncedAt)] : [],
                    )
                    .sort((a, b) => b.getTime() - a.getTime())[0] ?? null,
                )}
              </s-paragraph>
            </s-section>
          </div>
        </div>
      </div>
    </s-page>
  );
}

export const headers: HeadersFunction = (args) => boundary.headers(args);
export const ErrorBoundary = DashboardErrorBoundary;
