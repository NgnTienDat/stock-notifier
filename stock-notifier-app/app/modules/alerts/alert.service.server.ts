import type { InventoryLevel, Prisma, ShopSettings } from "@prisma/client";

type State = Pick<InventoryLevel, "isLowStock" | "isCurrent">;
type Scope = Pick<InventoryLevel, "shopDomain" | "locationGid">;
type AlertInventory = State &
  Scope &
  Pick<InventoryLevel, "id" | "availableQuantity">;
type AlertSettings = Pick<
  ShopSettings,
  "shopDomain" | "locationGid" | "lastSyncedAt" | "lowStockThreshold"
>;

export function getAlertTransition(
  previous: State | null,
  current: State,
  hasBaseline: boolean,
) {
  if (!hasBaseline || !current.isCurrent || !previous?.isCurrent)
    return "resolve";
  if (!current.isLowStock) return previous.isLowStock ? "resolve" : "none";
  return previous.isLowStock ? "none" : "create";
}

export async function resolveActiveAlerts(
  tx: Prisma.TransactionClient,
  scope: Scope,
  filter: Prisma.InventoryLevelWhereInput,
  now: Date,
) {
  const { count } = await tx.inventoryAlert.updateMany({
    where: { status: "ACTIVE", inventoryLevel: { AND: [scope, filter] } },
    data: { status: "RESOLVED", resolvedAt: now },
  });
  return count;
}

// Caller locks ShopSettings, reads the previous snapshot, then writes inventory in this transaction.
export async function applyInventoryAlertTransition(
  tx: Prisma.TransactionClient,
  settings: AlertSettings,
  previous: State | null,
  current: AlertInventory,
  now: Date,
) {
  if (
    current.shopDomain !== settings.shopDomain ||
    current.locationGid !== settings.locationGid
  ) {
    throw new Error(
      "Alert inventory does not belong to the selected shop/location",
    );
  }
  const transition = getAlertTransition(
    previous,
    current,
    settings.lastSyncedAt !== null,
  );
  if (transition === "resolve") {
    return {
      created: 0,
      resolved: await resolveActiveAlerts(
        tx,
        { shopDomain: current.shopDomain, locationGid: current.locationGid },
        { id: current.id },
        now,
      ),
    };
  }
  if (transition === "create") {
    // ON CONFLICT DO NOTHING honors the existing partial unique ACTIVE-alert index.
    const { count } = await tx.inventoryAlert.createMany({
      data: [
        {
          inventoryLevelId: current.id,
          quantityAtTrigger: current.availableQuantity,
          thresholdAtTrigger: settings.lowStockThreshold,
          triggeredAt: now,
        },
      ],
      skipDuplicates: true,
    });
    return { created: count, resolved: 0 };
  }
  return { created: 0, resolved: 0 };
}
