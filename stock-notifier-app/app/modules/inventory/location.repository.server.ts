import type { Prisma } from "@prisma/client";
import { resolveActiveAlerts } from "../alerts/alert.service.server";

// Caller holds the shop write lock before acquiring/updating a location.
export async function applyLocationState(
  tx: Prisma.TransactionClient,
  scope: { shopDomain: string; locationGid: string },
  metadata: { locationName: string; isActive: boolean } | null,
  now: Date,
  deleted = false,
) {
  const previous = await tx.monitoredLocation.findUnique({
    where: { shopDomain_locationGid: scope },
  });
  if (previous?.deletedAt) {
    deleted = true;
    metadata = null;
  }
  const active = !deleted && metadata?.isActive === true;
  const reactivated = previous?.isActive === false && active;
  const changed =
    !previous ||
    previous.isActive !== active ||
    (metadata && metadata.locationName !== previous.locationName) ||
    (deleted && !previous.deletedAt);
  const data = {
    isActive: active,
    ...(metadata ? { locationName: metadata.locationName } : {}),
    ...(deleted ? { deletedAt: previous?.deletedAt ?? now } : {}),
    ...(reactivated
      ? {
          baselineCompletedAt: null,
          baselineAlertsCompletedAt: null,
          lastSyncedAt: null,
          syncStatus: "PENDING" as const,
        }
      : {}),
  };
  const saved = !previous
    ? await tx.monitoredLocation.create({ data: { ...scope, ...data } })
    : changed
      ? await tx.monitoredLocation.update({
          where: { shopDomain_locationGid: scope },
          data: {
            ...data,
            version: { increment: 1 },
            ...(reactivated ||
            (previous.isActive === true && !active) ||
            (deleted && !previous.deletedAt)
              ? { generation: { increment: 1 } }
              : {}),
          },
        })
      : previous;
  if (!active) {
    await tx.inventoryLevel.updateMany({
      where: scope,
      data: { isCurrent: false },
    });
    await resolveActiveAlerts(
      tx,
      scope,
      {},
      now,
      deleted ? "LOCATION_DELETED" : "LOCATION_DEACTIVATED",
    );
  }
  return saved;
}
