export function parseDashboardFilters(url: URL) {
  const p = url.searchParams;
  const page = Number(p.get("page") ?? 1);
  return {
    location: p.get("location") || "all",
    stock: ["low", "normal"].includes(p.get("stock") ?? "")
      ? p.get("stock")!
      : "all",
    query: (p.get("q") ?? "").trim().slice(0, 200),
    page: Number.isSafeInteger(page) && page > 0 ? Math.min(page, 1000000) : 1,
    status: ["ACTIVE", "RESOLVED"].includes(p.get("status") ?? "")
      ? p.get("status")!
      : "all",
    origin: ["BASELINE", "THRESHOLD_CHANGE", "INVENTORY_TRANSITION"].includes(
      p.get("origin") ?? "",
    )
      ? p.get("origin")!
      : "all",
  };
}
export type DashboardFilters = ReturnType<typeof parseDashboardFilters>;
export const PAGE_SIZE = 20;
