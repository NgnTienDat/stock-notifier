import type { LoaderFunctionArgs, HeadersFunction } from "react-router";
import { useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getDashboard } from "../modules/dashboard/dashboard.repository.server";
import { parseDashboardFilters } from "../modules/dashboard/filters";
import { InventorySync } from "../modules/inventory/inventory-sync";
import {
  timestamp,
  ProductLabel,
  InventorySearch,
  LocationFilter,
  LocationCards,
  Pagination,
  EmptyState,
  MonitoringBanner,
  RecentAlerts,
  LoadingState,
  useViewFilters,
  DashboardErrorBoundary,
} from "../modules/dashboard/components";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const filters = parseDashboardFilters(new URL(request.url));
  return {
    view: await getDashboard(session.shop, filters),
    filters,
    botConfigured: !!process.env.TELEGRAM_BOT_TOKEN?.trim(),
  };
}

export default function Dashboard() {
  const { view, filters, botConfigured } = useLoaderData<typeof loader>();
  const { change } = useViewFilters();
  const busy = useNavigation().state !== "idle";
  const scoped = view.coverage.filter(
    (l) =>
      l.isActive &&
      (filters.location === "all" || l.locationGid === filters.location),
  );
  const ready = scoped.filter(
    (l) => l.baselineCompletedAt && l.baselineAlertsCompletedAt,
  );
  const latest = scoped
    .flatMap((l) => (l.lastSyncedAt ? [new Date(l.lastSyncedAt)] : []))
    .sort((a, b) => b.getTime() - a.getTime())[0];
  const metrics = [
    [
      "Active locations",
      scoped.length,
      `${ready.length} ready · ${scoped.length - ready.length} pending`,
    ],
    [
      "Products",
      ready.length ? view.counts.products : "—",
      "Unique products in view",
    ],
    [
      "Inventory items",
      ready.length ? view.counts.items : "—",
      "Across synced locations",
    ],
    [
      "Low stock",
      ready.length ? view.counts.low : "—",
      "Available ≤ threshold",
    ],
    [
      "Active alerts",
      ready.length ? view.counts.active : "—",
      "Including baseline alerts",
    ],
  ];
  return (
    <s-page heading="Inventory overview" inlineSize="large">
      <InventorySync busy={busy} compact />
      <div className="stockpulse">
        <p className="sp-intro">
          Track stock and alerts across every active Shopify location.
        </p>
        <div className="sp-block">
          <MonitoringBanner />
        </div>
        {view.counts.low > 0 && (
          <div className="sp-block">
            <s-banner
              heading={`${view.counts.low} inventory items are running low`}
              tone="warning"
            >
              Available stock is at or below the configured threshold.{" "}
              <s-link
                href={`?${new URLSearchParams({ location: filters.location, stock: "low" })}#inventory`}
              >
                View low stock
              </s-link>
            </s-banner>
          </div>
        )}
        <div className="sp-summary sp-block">
          <LocationFilter
            locations={view.coverage.filter((l) => l.isActive)}
            value={filters.location}
            onChange={(v) => change("location", v)}
          />
          <div>
            <span className="sp-eyebrow">Last sync</span>
            <strong>{timestamp(latest ?? null)}</strong>
          </div>
          <div>
            <span className="sp-eyebrow">Telegram</span>
            <strong>
              {botConfigured && view.settings?.telegramChatId
                ? "Configured"
                : "Not configured"}
            </strong>
          </div>
          <s-link href="/app/settings">Manage settings →</s-link>
        </div>
        <LoadingState />
        <div className="sp-metrics sp-block">
          {metrics.map(([label, value, foot]) => (
            <div className="sp-metric" key={label}>
              <div className="sp-metric-label">{label}</div>
              <div
                className={`sp-metric-number ${label === "Low stock" ? "sp-low" : ""}`}
              >
                {value}
              </div>
              <div className="sp-metric-foot">{foot}</div>
            </div>
          ))}
        </div>
        <div className="sp-block">
          <s-section heading="Location coverage">
            <p className="sp-secondary">
              Independent monitoring and baseline status for every active
              location
            </p>
            {view.coverage.some((l) => l.isActive) ? (
              <LocationCards
                locations={view.coverage}
                counts={view.locationCounts}
                onView={(id) => change("location", id)}
              />
            ) : (
              <EmptyState heading="No active locations discovered">
                Keep the inventory worker running or use Sync all locations to
                discover your store&apos;s locations.
              </EmptyState>
            )}
          </s-section>
        </div>
        <div className="sp-block" id="inventory">
          <s-section heading="Inventory">
            <p className="sp-secondary">
              Latest snapshots from synced locations · {view.total} items
            </p>
            <div className="sp-toolbar">
              <div
                className="sp-tabs"
                role="group"
                aria-label="Filter inventory"
              >
                {["all", "low", "normal"].map((value) => (
                  <s-button
                    key={value}
                    variant={filters.stock === value ? "secondary" : "tertiary"}
                    onClick={() => change("stock", value)}
                  >
                    {value === "all"
                      ? "All"
                      : value === "low"
                        ? "Low stock"
                        : "Normal"}
                  </s-button>
                ))}
              </div>
              <InventorySearch
                value={filters.query}
                onChange={(value) => change("q", value)}
              />
            </div>
            {view.rows.length ? (
              <div className="sp-table">
                <s-table>
                  <s-table-header-row>
                    {[
                      "Product / variant",
                      "Location",
                      "SKU",
                      "Available",
                      "Threshold",
                      "Stock status",
                      "Alert",
                    ].map((heading) => (
                      <s-table-header key={heading}>{heading}</s-table-header>
                    ))}
                  </s-table-header-row>
                  <s-table-body>
                    {view.rows.map((row) => (
                      <s-table-row key={row.id}>
                        <s-table-cell>
                          <ProductLabel
                            variants={row.variants}
                            fallback={row.inventoryItemGid}
                          />
                        </s-table-cell>
                        <s-table-cell>
                          {row.locationName || row.locationGid}
                        </s-table-cell>
                        <s-table-cell>{row.sku ?? "—"}</s-table-cell>
                        <s-table-cell>
                          <span
                            className={`sp-number ${row.isLowStock ? "sp-low" : ""}`}
                          >
                            {row.availableQuantity}
                          </span>
                        </s-table-cell>
                        <s-table-cell>
                          {view.settings?.lowStockThreshold}
                        </s-table-cell>
                        <s-table-cell>
                          <s-badge
                            tone={
                              row.availableQuantity <= 0
                                ? "critical"
                                : row.isLowStock
                                  ? "warning"
                                  : "success"
                            }
                          >
                            {row.availableQuantity <= 0
                              ? "Out of stock"
                              : row.isLowStock
                                ? "Low stock"
                                : "Normal"}
                          </s-badge>
                        </s-table-cell>
                        <s-table-cell>
                          {row.active ? (
                            <s-badge tone="warning">Active</s-badge>
                          ) : (
                            "—"
                          )}
                        </s-table-cell>
                      </s-table-row>
                    ))}
                  </s-table-body>
                </s-table>
              </div>
            ) : (
              <EmptyState
                heading={
                  filters.query || filters.stock !== "all"
                    ? "No matching items"
                    : "No inventory snapshots yet"
                }
              >
                {scoped.some((l) => !l.baselineAlertsCompletedAt)
                  ? "This location's independent baseline is pending; other locations continue monitoring."
                  : "Try another location, stock filter or search term, or sync all locations."}
              </EmptyState>
            )}
            {view.total === 0 && (filters.query || filters.stock !== "all") && (
              <s-link
                href={`?${new URLSearchParams({ location: filters.location })}`}
              >
                Clear filters
              </s-link>
            )}
            <Pagination
              page={view.page}
              total={view.total}
              onPage={(p) => change("page", String(p))}
            />
          </s-section>
        </div>
        <s-section heading="Recent alerts">
          <div className="sp-panel-head">
            <p className="sp-secondary">
              Inventory transitions, baseline and threshold-change digests
            </p>
            <s-link
              href={`/app/alerts?${new URLSearchParams({ location: filters.location })}`}
            >
              View history →
            </s-link>
          </div>
          <RecentAlerts alerts={view.recent} locations={view.coverage} />
        </s-section>
        <p className="sp-helper">
          StockPulse · PostgreSQL snapshots · Times shown in UTC
        </p>
      </div>
    </s-page>
  );
}
export const ErrorBoundary = DashboardErrorBoundary;
export const headers: HeadersFunction = (args) => boundary.headers(args);
