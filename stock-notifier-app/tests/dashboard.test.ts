import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, test, vi } from "vitest";
import { parseDashboardFilters } from "../app/modules/dashboard/filters";
import {
  LoadingState,
  EmptyState,
  ProductLabel,
} from "../app/modules/dashboard/components";
import { useNavigation } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { loader as appLoader } from "../app/routes/app";
import { authenticate } from "../app/shopify.server";
import { getCoverage } from "../app/modules/dashboard/dashboard.repository.server";
import { bindValueChange } from "../app/modules/dashboard/value-events";

vi.mock("../app/shopify.server", () => ({ authenticate: { admin: vi.fn() } }));
vi.mock("../app/modules/dashboard/dashboard.repository.server", () => ({
  getCoverage: vi.fn(),
}));

vi.mock("react-router", async (original) => ({
  ...(await original<typeof import("react-router")>()),
  useNavigation: vi.fn(),
}));
afterEach(() => vi.clearAllMocks());
test.each(["NaN", "0", "-1", "2.5", "Infinity"])(
  "invalid page %s defaults safely without trusting tenant inputs",
  (page) => {
    expect(
      parseDashboardFilters(
        new URL(
          `https://app.test/app?shop=victim&shopDomain=forged&page=${page}&stock=invalid&origin=invalid&status=invalid`,
        ),
      ),
    ).toEqual({
      location: "all",
      stock: "all",
      query: "",
      page: 1,
      status: "all",
      origin: "all",
    });
  },
);
test("view filters preserve opaque GIDs, bound search/page and accept only approved enums", () => {
  const location = "gid://shopify/Location/1";
  const p = new URLSearchParams({
    location,
    q: "x".repeat(300),
    page: "99999999",
    stock: "low",
    status: "ACTIVE",
    origin: "BASELINE",
  });
  const result = parseDashboardFilters(new URL(`https://app.test/app?${p}`));
  expect(result).toMatchObject({
    location,
    page: 1000000,
    stock: "low",
    status: "ACTIVE",
    origin: "BASELINE",
  });
  expect(result.query).toHaveLength(200);
});
test("loading is announced and empty state uses genuine text rather than dummy inventory", () => {
  vi.mocked(useNavigation).mockReturnValue({ state: "loading" } as ReturnType<
    typeof useNavigation
  >);
  expect(renderToStaticMarkup(createElement(LoadingState))).toContain(
    'accessibilityLabel="Loading snapshots"',
  );
  vi.mocked(useNavigation).mockReturnValue({ state: "idle" } as ReturnType<
    typeof useNavigation
  >);
  expect(renderToStaticMarkup(createElement(LoadingState))).toBe("");
  const empty = renderToStaticMarkup(
    createElement(
      EmptyState,
      { heading: "No inventory snapshots yet" },
      "Baseline pending",
    ),
  );
  expect(empty).toContain("Baseline pending");
  expect(empty).not.toContain("quantity");
});
test("product metadata retains all variants and escapes merchant text", () => {
  const html = renderToStaticMarkup(
    createElement(ProductLabel, {
      fallback: "Inventory item",
      variants: [
        { productTitle: "<script>bad</script>", variantTitle: "Ice" },
        { productTitle: "Other", variantTitle: "Snow" },
      ],
    }),
  );
  expect(html).toContain("&lt;script&gt;bad&lt;/script&gt;");
  expect(html).toContain("Snow");
  expect(html).not.toContain("<script>");
});

test("coverage failure preserves the authenticated shell and returns a sanitized error", async () => {
  vi.mocked(authenticate.admin).mockResolvedValue({
    session: { shop: "fixture.myshopify.com" },
  } as Awaited<ReturnType<typeof authenticate.admin>>);
  vi.mocked(getCoverage).mockRejectedValueOnce(
    Error("private database credentials"),
  );
  const view = await appLoader({
    request: new Request("https://app.test/app?shop=foreign"),
    params: {},
    context: {},
  } as LoaderFunctionArgs);
  expect(getCoverage).toHaveBeenCalledWith("fixture.myshopify.com");
  expect(view.coverage).toEqual([]);
  expect(view.coverageError).toBe(
    "Location coverage could not be loaded. Please retry.",
  );
});

test("shell authentication errors propagate before attempting database coverage", async () => {
  vi.mocked(authenticate.admin).mockRejectedValueOnce(
    new Response(null, { status: 401 }),
  );
  await expect(
    appLoader({
      request: new Request("https://app.test/app"),
      params: {},
      context: {},
    } as LoaderFunctionArgs),
  ).rejects.toMatchObject({ status: 401 });
  expect(getCoverage).not.toHaveBeenCalled();
});

test("Polaris native change events work without React 19 and subscriptions clean up on rerender", () => {
  const field = Object.assign(new EventTarget(), { value: "all" });
  const change = vi.fn();
  const cleanup = bindValueChange(field, change);
  field.value = "gid://shopify/Location/2";
  field.dispatchEvent(new Event("change"));
  expect(change).toHaveBeenCalledExactlyOnceWith("gid://shopify/Location/2");
  cleanup();
  field.value = "all";
  field.dispatchEvent(new Event("change"));
  expect(change).toHaveBeenCalledTimes(1);
  const next = vi.fn();
  const remove = bindValueChange(field, next);
  field.dispatchEvent(new Event("change"));
  expect(next).toHaveBeenCalledWith("all");
  remove();
});
