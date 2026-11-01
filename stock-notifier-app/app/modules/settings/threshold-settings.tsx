import { useEffect, useState } from "react";
import { useFetcher } from "react-router";
import type { action } from "../../routes/app.settings.threshold";

export function ThresholdSettings({
  threshold,
  busy,
}: {
  threshold: number;
  busy: boolean;
}) {
  const [value, setValue] = useState(String(threshold));
  useEffect(() => setValue(String(threshold)), [threshold]);
  const fetcher = useFetcher<typeof action>();
  const saving = fetcher.state !== "idle";
  return (
    <s-section heading="Low-stock threshold">
      <fetcher.Form method="post" action="/app/settings/threshold">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Inventory at or below this quantity is low stock. This threshold
            applies to all monitored locations.
          </s-paragraph>
          <label htmlFor="lowStockThreshold">Low-stock threshold</label>
          <input
            id="lowStockThreshold"
            name="lowStockThreshold"
            type="number"
            min="0"
            max="2147483647"
            step="1"
            required
            value={value}
            disabled={busy || saving}
            onChange={(event) => setValue(event.target.value)}
          />
          <s-paragraph>
            Changing the threshold updates inventory status and closes alerts
            that no longer apply. Newly low items are grouped into one digest
            for this threshold change when Telegram is configured; they are not
            sent individually.
          </s-paragraph>
          {!saving && fetcher.data?.error && (
            <s-banner heading="Threshold was not saved" tone="critical">
              {fetcher.data.error}
            </s-banner>
          )}
          {!saving && fetcher.data?.saved && Number(value) === threshold && (
            <s-banner heading="Threshold saved" tone="success">
              Inventory status has been updated.
            </s-banner>
          )}
          <s-button
            type="submit"
            variant="primary"
            loading={saving || undefined}
            disabled={busy || saving || undefined}
          >
            Save threshold
          </s-button>
        </s-stack>
      </fetcher.Form>
    </s-section>
  );
}
