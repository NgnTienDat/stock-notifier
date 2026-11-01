import { useFetcher } from "react-router";
import type { action } from "../../routes/app.inventory-sync";

export function InventorySync({ busy }: { busy: boolean }) {
  const fetcher = useFetcher<typeof action>();
  const syncing = fetcher.state !== "idle";
  const result = fetcher.data?.result;
  return (
    <s-section heading="Inventory sync">
      <s-stack direction="block" gap="base">
        <s-paragraph>
          Discover and sync all active Shopify locations.
        </s-paragraph>

        {syncing && <s-spinner accessibilityLabel="Syncing inventory" />}
        {!syncing && fetcher.data?.error && (
          <s-banner heading="Sync did not complete" tone="critical">
            {fetcher.data.error}
          </s-banner>
        )}
        {!syncing && result && (
          <s-banner
            heading={
              result.baseline
                ? "Initial sync complete"
                : "Inventory sync complete"
            }
            tone={result.failedCount ? "critical" : "success"}
          >
            {result.failedCount} locations failed. {result.itemCount} inventory
            items synced; {result.staleCount} old snapshots marked inactive.{" "}
            {result.alertsCreated} alerts created; {result.alertsResolved}{" "}
            alerts resolved.
          </s-banner>
        )}
        {result?.locations.map((location) => (
          <div key={location.locationGid}>
            <s-paragraph>
              {location.locationGid}: {location.error ?? "Synced"}
            </s-paragraph>
            {location.error && (
              <fetcher.Form method="post" action="/app/inventory-sync">
                <input
                  type="hidden"
                  name="retryLocationGid"
                  value={location.locationGid}
                />
                <s-button type="submit" disabled={busy || syncing || undefined}>
                  Retry location
                </s-button>
              </fetcher.Form>
            )}
          </div>
        ))}
        <fetcher.Form method="post" action="/app/inventory-sync">
          <s-button
            type="submit"
            variant="primary"
            loading={syncing || undefined}
            disabled={busy || syncing || undefined}
          >
            Sync now
          </s-button>
        </fetcher.Form>
      </s-stack>
    </s-section>
  );
}
