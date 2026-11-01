import type { LoaderFunctionArgs, HeadersFunction } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  getAlertHistory,
  getCoverage,
} from "../modules/dashboard/dashboard.repository.server";
import { parseDashboardFilters } from "../modules/dashboard/filters";
import {
  timestamp,
  originLabel,
  ProductLabel,
  ViewSelect,
  LocationFilter,
  Pagination,
  EmptyState,
  DeliveryBadge,
  LoadingState,
  useViewFilters,
  DashboardErrorBoundary,
} from "../modules/dashboard/components";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const filters = parseDashboardFilters(new URL(request.url));
  const [view, locations] = await Promise.all([
    getAlertHistory(session.shop, filters),
    getCoverage(session.shop),
  ]);
  return { view, locations, filters };
}
export default function AlertHistory() {
  const { view, locations, filters } = useLoaderData<typeof loader>();
  const { change } = useViewFilters();
  return (
    <s-page heading="Alert history" inlineSize="large">
      <s-link slot="breadcrumb-actions" href="/app">
        ← Back to dashboard
      </s-link>
      <div className="stockpulse">
        <p className="sp-intro">
          Active and resolved alerts across every location, with origin and
          delivery state.
        </p>
        <LoadingState />
        <s-section heading="Inventory alerts">
          <p className="sp-secondary">
            {view.total} events · Transition messages are immediate; baseline
            and threshold alerts use digests.
          </p>
          <div className="sp-history-filters">
            <LocationFilter
              locations={locations}
              value={filters.location}
              onChange={(v) => change("location", v)}
            />
            <ViewSelect
              label="Status"
              value={filters.status}
              onChange={(value) => change("status", value)}
            >
              <s-option value="all">All statuses</s-option>
              <s-option value="ACTIVE">Active</s-option>
              <s-option value="RESOLVED">Resolved</s-option>
            </ViewSelect>
            <ViewSelect
              label="Origin"
              value={filters.origin}
              onChange={(value) => change("origin", value)}
            >
              <s-option value="all">All origins</s-option>
              {["INVENTORY_TRANSITION", "BASELINE", "THRESHOLD_CHANGE"].map(
                (o) => (
                  <s-option key={o} value={o}>
                    {originLabel(o)}
                  </s-option>
                ),
              )}
            </ViewSelect>
          </div>
          {view.rows.length ? (
            <div className="sp-table">
              <s-table>
                <s-table-header-row>
                  {[
                    "Product / variant",
                    "Location",
                    "At trigger",
                    "Threshold",
                    "Origin",
                    "Status",
                    "Telegram",
                    "Triggered",
                  ].map((h) => (
                    <s-table-header key={h}>{h}</s-table-header>
                  ))}
                </s-table-header-row>
                <s-table-body>
                  {view.rows.map((a) => (
                    <s-table-row key={a.id}>
                      <s-table-cell>
                        <ProductLabel
                          variants={a.inventoryLevel.variants}
                          fallback={
                            a.inventoryLevel.sku ||
                            a.inventoryLevel.inventoryItemGid
                          }
                        />
                      </s-table-cell>
                      <s-table-cell>
                        {locations.find(
                          (l) => l.locationGid === a.inventoryLevel.locationGid,
                        )?.locationName || a.inventoryLevel.locationGid}
                      </s-table-cell>
                      <s-table-cell>{a.quantityAtTrigger}</s-table-cell>
                      <s-table-cell>{a.thresholdAtTrigger}</s-table-cell>
                      <s-table-cell>
                        <s-badge
                          tone={
                            a.origin === "INVENTORY_TRANSITION"
                              ? "info"
                              : "neutral"
                          }
                        >
                          {originLabel(a.origin)}
                        </s-badge>
                      </s-table-cell>
                      <s-table-cell>
                        <s-badge
                          tone={a.status === "ACTIVE" ? "warning" : "neutral"}
                        >
                          {a.status === "ACTIVE" ? "Active" : "Resolved"}
                        </s-badge>
                        {a.resolutionReason && (
                          <div className="sp-secondary">
                            {a.resolutionReason
                              .replaceAll("_", " ")
                              .toLowerCase()}
                          </div>
                        )}
                      </s-table-cell>
                      <s-table-cell>
                        <DeliveryBadge alert={a} />
                        {a.digest && (
                          <div className="sp-secondary">
                            Batch {a.digest.id} · {a.digest.attempts} attempts
                            {a.digest.notifiedAt
                              ? ` · ${timestamp(a.digest.notifiedAt)}`
                              : ""}
                          </div>
                        )}
                      </s-table-cell>
                      <s-table-cell>{timestamp(a.triggeredAt)}</s-table-cell>
                    </s-table-row>
                  ))}
                </s-table-body>
              </s-table>
            </div>
          ) : (
            <EmptyState heading="No alerts match your filters">
              Try All locations, all statuses or another origin.
            </EmptyState>
          )}
          <Pagination
            page={view.page}
            total={view.total}
            onPage={(p) => change("page", String(p))}
          />
        </s-section>
      </div>
    </s-page>
  );
}
export const ErrorBoundary = DashboardErrorBoundary;
export const headers: HeadersFunction = (args) => boundary.headers(args);
