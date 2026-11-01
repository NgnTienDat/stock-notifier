import type { Prisma } from "@prisma/client";
import type { DigestClaim, readDigest } from "./digest.repository.server";

type DigestData = NonNullable<Awaited<ReturnType<typeof readDigest>>>;
const clip = (s: string, n = 140) =>
  s.length <= n ? s : s.slice(0, n - 1).replace(/[\uD800-\uDBFF]$/, "") + "…";
export function variantNames(variants: Prisma.JsonValue, fallback: string) {
  const values = Array.isArray(variants) ? variants : [];
  const names = values.flatMap((v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? [
          `${typeof v.productTitle === "string" ? v.productTitle : "Product"} / ${typeof v.variantTitle === "string" ? v.variantTitle : "Variant"}`,
        ]
      : [],
  );
  return names.length ? names.join("; ") : fallback;
}

export function formatDigest(
  claim: Pick<
    DigestClaim,
    | "shopDomain"
    | "origin"
    | "createdAt"
    | "oldThreshold"
    | "newThreshold"
    | "locations"
  >,
  data: DigestData,
) {
  const expected = Array.isArray(claim.locations) ? claim.locations : [];
  const coverage = expected
    .map((v) => {
      const id =
        v && typeof v === "object" && !Array.isArray(v) ? v.locationGid : null;
      const location = data.locations.find((l) => l.locationGid === id);
      return {
        count: data.alerts.filter((a) => a.inventoryLevel.locationGid === id)
          .length,
        name: clip(location?.locationName || String(id ?? "Location"), 80),
        state: !location?.isActive
          ? "inactive"
          : location.lastSyncError
            ? "failed"
            : !location.baselineAlertsCompletedAt
              ? "pending"
              : "ready",
      };
    })
    .filter((location) => claim.origin === "BASELINE" || location.count > 0);
  const lines = [
    claim.origin === "BASELINE"
      ? "Baseline digest — StockPulse"
      : "Threshold change digest — StockPulse",
    `Store: ${clip(claim.shopDomain, 120)}`,
    `${claim.origin === "BASELINE" ? "Baseline batch" : "Changed"}: ${claim.createdAt.toISOString()}`,
    ...(claim.origin === "THRESHOLD_CHANGE"
      ? [`Threshold: ${claim.oldThreshold} → ${claim.newThreshold}`]
      : []),
    `Low-stock items: ${data.alerts.length}`,
    `Locations: ${coverage.filter((l) => l.state === "ready").length} ready; ${coverage.filter((l) => l.state === "pending").length} pending; ${coverage.filter((l) => l.state === "failed").length} failed; ${coverage.filter((l) => l.state === "inactive").length} inactive`,
    ...coverage
      .slice(0, 6)
      .map((l) => `${l.name}: ${l.state} · ${l.count} low-stock items`),
    ...(coverage.length > 6 ? [`${coverage.length - 6} more locations`] : []),
    "Current low-stock items (available / trigger threshold):",
  ];
  let shown = 0;
  for (const alert of data.alerts) {
    const item = alert.inventoryLevel;
    const name =
      data.locations.find((l) => l.locationGid === item.locationGid)
        ?.locationName || item.locationGid;
    const line = `${clip(name, 90)} · ${clip(variantNames(item.variants, item.sku || item.inventoryItemGid), 160)}: ${item.availableQuantity} / ${alert.thresholdAtTrigger}`;
    if (lines.join("\n").length + line.length + 100 > 4096) break;
    lines.push(line);
    shown++;
  }
  if (shown < data.alerts.length)
    lines.push(
      `${data.alerts.length - shown} more items omitted; total above includes all current eligible items.`,
    );
  // Plain text: no parse_mode, so merchant HTML/Markdown is never interpreted.
  return lines.join("\n");
}
