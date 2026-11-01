import { expect, test } from "vitest";
import { getAlertTransition } from "../app/modules/alerts/alert.service.server";
import { parseLowStockThreshold } from "../app/modules/settings/settings.service.server";

test.each([
  [false, true, "create"],
  [true, true, "none"],
  [true, false, "resolve"],
  [false, false, "none"],
] as const)("stored low-stock flag %s → %s: %s", (before, after, decision) => {
  expect(
    getAlertTransition(
      { isCurrent: true, isLowStock: before },
      { isCurrent: true, isLowStock: after },
      true,
    ),
  ).toBe(decision);
});

test("missing shop/item baseline and inactive snapshots never create alerts", () => {
  const normal = { isCurrent: true, isLowStock: false };
  const low = { isCurrent: true, isLowStock: true };
  expect(getAlertTransition(normal, low, false)).toBe("resolve");
  expect(getAlertTransition(null, low, true)).toBe("resolve");
  expect(getAlertTransition({ ...normal, isCurrent: false }, low, true)).toBe(
    "resolve",
  );
  expect(getAlertTransition(normal, { ...low, isCurrent: false }, true)).toBe(
    "resolve",
  );
});

test("threshold validation rejects malformed values and PostgreSQL integer overflow", () => {
  for (const value of [
    null,
    "",
    " ",
    "-1",
    "1.5",
    "NaN",
    "Infinity",
    "2147483648",
    {},
    ["5"],
  ]) {
    expect(() => parseLowStockThreshold(value)).toThrow();
  }
  expect(parseLowStockThreshold("0")).toBe(0);
  expect(parseLowStockThreshold("2147483647")).toBe(2147483647);
});
