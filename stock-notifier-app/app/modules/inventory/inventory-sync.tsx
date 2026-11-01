import { useFetcher } from "react-router";
import type { action } from "../../routes/app.inventory-sync";

export function InventorySync({
  locationGid,
  lastSyncedAt,
  busy,
}: {
  locationGid: string | null;
  lastSyncedAt: Date | null;
  busy: boolean;
}) {
  const fetcher = useFetcher<typeof action>();
  const syncing = fetcher.state !== "idle";
  const result = fetcher.data?.result;
  return (
    <s-section heading="Inventory sync">
      <s-stack direction="block" gap="base">
        <s-paragraph>Refresh inventory from your saved location.</s-paragraph>
        <s-paragraph>
          {lastSyncedAt
            ? `Last successful sync: ${lastSyncedAt.toLocaleString("en-GB", { timeZone: "UTC" })} UTC`
            : "No successful sync for this location yet."}
        </s-paragraph>
        {!locationGid && (
          <s-paragraph>Select and save a location first.</s-paragraph>
        )}
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
            tone="success"
          >
            {result.itemCount} inventory items synced; {result.staleCount} old
            snapshots marked inactive. {result.alertsCreated} alerts created;{" "}
            {result.alertsResolved} alerts resolved.
          </s-banner>
        )}
        <fetcher.Form method="post" action="/app/inventory-sync">
          <s-button
            type="submit"
            variant="primary"
            loading={syncing || undefined}
            disabled={busy || syncing || !locationGid || undefined}
          >
            Sync now
          </s-button>
        </fetcher.Form>
      </s-stack>
    </s-section>
  );
}
