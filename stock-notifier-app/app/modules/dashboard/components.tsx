import type {
  InventoryAlert,
  InventoryLevel,
  NotificationDigest,
  Prisma,
} from "@prisma/client";
import { useEffect, useRef } from "react";
import {
  useSearchParams,
  useNavigation,
  useRevalidator,
  isRouteErrorResponse,
  useRouteError,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { variantNames } from "../notifications/digest-format";
import type { getCoverage } from "./dashboard.repository.server";
import { PAGE_SIZE } from "./filters";
import { bindValueChange } from "./value-events";

export const timestamp = (value: Date | string | null) =>
  value
    ? new Date(value)
        .toISOString()
        .replace("T", " ")
        .replace(/\.\d{3}Z$/, " UTC")
    : "Not synced yet";
export const originLabel = (origin: string) =>
  ({
    INVENTORY_TRANSITION: "Inventory change",
    BASELINE: "Baseline",
    THRESHOLD_CHANGE: "Threshold change",
  })[origin] || origin;
export function ProductLabel({
  variants,
  fallback,
}: {
  variants: Prisma.JsonValue;
  fallback: string;
}) {
  const names = variantNames(variants, fallback).split("; ");
  return (
    <div className="sp-product">
      <span className="sp-thumb">
        <s-icon type="product" />
      </span>
      <div>
        <strong>{names[0]}</strong>
        {names.slice(1).map((name, index) => (
          <div className="sp-secondary" key={index}>
            {name}
          </div>
        ))}
      </div>
    </div>
  );
}
export function DeliveryBadge({
  alert,
}: {
  alert: InventoryAlert & { digest: NotificationDigest | null };
}) {
  const d = alert.digest;
  const label =
    alert.notificationStatus === "SENT"
      ? "Sent"
      : d
        ? `Digest ${d.status.toLowerCase()}${d.nextAttemptAt && d.status === "FAILED" ? " · retry scheduled" : ""}`
        : alert.origin !== "INVENTORY_TRANSITION"
          ? "Not scheduled"
          : alert.notificationNextAttemptAt
            ? `${alert.notificationStatus.toLowerCase()} · scheduled`
            : alert.notificationStatus === "FAILED"
              ? "Failed"
              : "Not scheduled";
  return (
    <s-badge
      tone={
        alert.notificationStatus === "SENT"
          ? "success"
          : d?.status === "FAILED" || alert.notificationStatus === "FAILED"
            ? "critical"
            : "neutral"
      }
    >
      {label}
    </s-badge>
  );
}
export function useViewFilters() {
  const [params, setParams] = useSearchParams();
  return {
    params,
    change: (key: string, value: string) => {
      const next = new URLSearchParams(params);
      next.set(key, value);
      if (key !== "page") next.delete("page");
      setParams(next, { preventScrollReset: true });
    },
  };
}
export function LocationFilter({
  locations,
  value,
  onChange,
}: {
  locations: Awaited<ReturnType<typeof getCoverage>>;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <ViewSelect label="View inventory for" value={value} onChange={onChange}>
      <s-option value="all">All locations</s-option>
      {locations.map((l) => (
        <s-option key={l.locationGid} value={l.locationGid}>
          {l.locationName || l.locationGid}
          {l.isActive ? "" : " (inactive)"}
        </s-option>
      ))}
    </ViewSelect>
  );
}

export function ViewSelect({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLElementTagNameMap["s-select"]>(null);
  useEffect(() => {
    if (ref.current) ref.current.value = value;
  }, [value]);
  useEffect(
    () => (ref.current ? bindValueChange(ref.current, onChange) : undefined),
    [onChange],
  );
  return (
    <s-select ref={ref} label={label} value={value}>
      {children}
    </s-select>
  );
}

export function InventorySearch({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const ref = useRef<HTMLElementTagNameMap["s-search-field"]>(null);
  useEffect(() => {
    if (ref.current) ref.current.value = value;
  }, [value]);
  useEffect(
    () => (ref.current ? bindValueChange(ref.current, onChange) : undefined),
    [onChange],
  );
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (ref.current) onChange(ref.current.value);
      }}
    >
      <s-search-field
        ref={ref}
        label="Search inventory"
        labelAccessibilityVisibility="exclusive"
        placeholder="Search product, SKU or location"
        value={value}
      />
    </form>
  );
}
export function Pagination({
  page,
  total,
  onPage,
}: {
  page: number;
  total: number;
  onPage: (page: number) => void;
}) {
  return (
    <div className="sp-footer">
      <span>
        {total
          ? `Showing ${(page - 1) * PAGE_SIZE + 1}–${Math.min(page * PAGE_SIZE, total)} of ${total}`
          : "0 results"}
      </span>
      <s-stack direction="inline" gap="small">
        <s-button
          disabled={page <= 1 || undefined}
          onClick={() => onPage(page - 1)}
        >
          ← Previous
        </s-button>
        <s-button
          disabled={page * PAGE_SIZE >= total || undefined}
          onClick={() => onPage(page + 1)}
        >
          Next →
        </s-button>
      </s-stack>
    </div>
  );
}
export function EmptyState({
  heading,
  children,
}: {
  heading: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="sp-empty">
      <s-icon type="product" />
      <h3>{heading}</h3>
      <p>{children}</p>
    </div>
  );
}
export function MonitoringBanner() {
  return (
    <s-banner heading="Automatic monitoring is on" tone="success">
      All active Shopify locations are monitored. Changing the location filter
      never stops monitoring, resets a baseline or resolves alerts.
    </s-banner>
  );
}
export function LocationCards({
  locations,
  counts,
  onView,
}: {
  locations: Awaited<ReturnType<typeof getCoverage>>;
  counts?: { locationGid: string; items: number; low: number }[];
  onView?: (id: string) => void;
}) {
  return (
    <div className="sp-locations">
      {locations
        .filter((l) => l.isActive)
        .map((l) => {
          const ready =
            !!l.baselineCompletedAt && !!l.baselineAlertsCompletedAt;
          const count = counts?.find((c) => c.locationGid === l.locationGid);
          return (
            <div className="sp-location" key={l.locationGid}>
              <div className="sp-location-head">
                <h3>{l.locationName || l.locationGid}</h3>
                <s-badge
                  tone={
                    l.lastSyncError ? "critical" : ready ? "success" : "warning"
                  }
                >
                  {l.lastSyncError
                    ? "Sync failed"
                    : ready
                      ? "Ready"
                      : "Baseline pending"}
                </s-badge>
              </div>
              <p>Last sync: {timestamp(l.lastSyncedAt)}</p>
              {l.lastSyncError && (
                <s-paragraph tone="critical">{l.lastSyncError}</s-paragraph>
              )}
              {counts && (
                <>
                  <div className="sp-stat">
                    <span>Tracked items</span>
                    <strong>{ready ? (count?.items ?? 0) : "—"}</strong>
                  </div>
                  <div className="sp-stat">
                    <span>Low stock</span>
                    <strong>{ready ? (count?.low ?? 0) : "—"}</strong>
                  </div>
                </>
              )}
              {onView && (
                <s-button onClick={() => onView(l.locationGid)}>
                  View inventory
                </s-button>
              )}
            </div>
          );
        })}
    </div>
  );
}
export function RecentAlerts({
  alerts,
  locations,
}: {
  alerts: (InventoryAlert & {
    inventoryLevel: InventoryLevel;
    digest: NotificationDigest | null;
  })[];
  locations: Awaited<ReturnType<typeof getCoverage>>;
}) {
  return alerts.length ? (
    alerts.map((a) => (
      <div className="sp-recent" key={a.id}>
        <span className="sp-recent-icon">
          <s-icon type={a.status === "ACTIVE" ? "alert-triangle" : "check"} />
        </span>
        <div>
          <strong>
            {variantNames(
              a.inventoryLevel.variants,
              a.inventoryLevel.sku || a.inventoryLevel.inventoryItemGid,
            )}
          </strong>
          <div className="sp-secondary">
            {locations.find(
              (l) => l.locationGid === a.inventoryLevel.locationGid,
            )?.locationName || a.inventoryLevel.locationGid}{" "}
            · {originLabel(a.origin)} · {timestamp(a.triggeredAt)}
          </div>
        </div>
        <div className="sp-recent-right">
          <s-badge tone={a.status === "ACTIVE" ? "warning" : "neutral"}>
            {a.status === "ACTIVE" ? "Active" : "Resolved"}
          </s-badge>
          <DeliveryBadge alert={a} />
        </div>
      </div>
    ))
  ) : (
    <EmptyState heading="No alerts for this location">
      Try All locations or wait for an inventory transition.
    </EmptyState>
  );
}
export function LoadingState() {
  const navigation = useNavigation();
  return navigation.state !== "idle" ? (
    <div role="status">
      <s-spinner accessibilityLabel="Loading snapshots" />
      <s-text>Loading inventory snapshots…</s-text>
    </div>
  ) : null;
}
export function DashboardErrorBoundary() {
  const error = useRouteError();
  const revalidator = useRevalidator();
  if (
    isRouteErrorResponse(error) &&
    (error.status === 401 || error.status === 403)
  )
    return boundary.error(error);
  return (
    <s-page heading="StockPulse">
      <s-section>
        <EmptyState heading="Couldn't load inventory">
          Please retry loading the inventory snapshots.
        </EmptyState>
        <s-button
          onClick={() => revalidator.revalidate()}
          loading={revalidator.state !== "idle" || undefined}
        >
          Retry
        </s-button>
      </s-section>
    </s-page>
  );
}
