import { useState } from "react";
import type { LocationData } from "../shopify/graphql/types";

type Props = {
  locations: LocationData[];
  selected: { locationGid: string | null; locationName: string | null } | null;
  error: string | null;
  saved: boolean;
  busy: boolean;
  onRetry: () => void;
};

export function LocationSelection({
  locations,
  selected,
  error,
  saved,
  busy,
  onRetry,
}: Props) {
  const initial =
    locations.find((location) => location.locationGid === selected?.locationGid)
      ?.locationGid ?? "";
  const [locationGid, setLocationGid] = useState(initial);
  const unavailable =
    selected?.locationGid &&
    !locations.some(
      (location) => location.locationGid === selected.locationGid,
    );

  return (
    <s-section heading="Inventory location">
      <s-stack direction="block" gap="base">
        <s-paragraph>Choose one location to monitor inventory.</s-paragraph>
        {selected?.locationGid && (
          <s-paragraph>
            Saved location: {selected.locationName ?? selected.locationGid}
          </s-paragraph>
        )}
        {error && (
          <s-banner heading="Could not save or load locations" tone="critical">
            {error}
          </s-banner>
        )}
        {saved && !error && locationGid === selected?.locationGid && (
          <s-banner heading="Location saved" tone="success">
            Your selection is saved.
          </s-banner>
        )}
        {busy && <s-spinner accessibilityLabel="Loading location settings" />}
        {error && (
          <s-button onClick={onRetry} disabled={busy || undefined}>
            Reload locations
          </s-button>
        )}
        {!error && locations.length === 0 && (
          <s-paragraph>
            No active locations are available. Activate a location in Shopify,
            then reload this page.
          </s-paragraph>
        )}
        {!error && unavailable && locations.length > 0 && (
          <s-banner
            heading="Saved location is no longer available"
            tone="warning"
          >
            Choose another active location.
          </s-banner>
        )}
        {locations.length > 0 && (
          <>
            <label htmlFor="locationGid">Location</label>
            <select
              id="locationGid"
              name="locationGid"
              value={locationGid}
              required
              disabled={busy}
              onChange={(event) => setLocationGid(event.target.value)}
            >
              <option value="" disabled>
                Select a location
              </option>
              {locations.map((location) => (
                <option key={location.locationGid} value={location.locationGid}>
                  {location.locationName}
                </option>
              ))}
            </select>
            <s-paragraph>
              Changing location closes active alerts for the previous location
              and keeps their history.
            </s-paragraph>
            <s-button
              variant="primary"
              type="submit"
              loading={busy || undefined}
              disabled={busy || !locationGid || undefined}
            >
              Save location
            </s-button>
          </>
        )}
      </s-stack>
    </s-section>
  );
}
