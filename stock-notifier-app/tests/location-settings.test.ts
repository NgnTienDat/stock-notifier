import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Session } from "@shopify/shopify-api";
import type { AdminGraphqlClient } from "@shopify/shopify-app-react-router/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authenticate } from "../app/shopify.server";
import { loader, action } from "../app/routes/app.settings";
import { action as thresholdAction } from "../app/routes/app.settings.threshold";
import { LocationSelection } from "../app/modules/settings/location-selection";
import {
  getLocationSettings,
  saveLocationSettings,
  saveLowStockThreshold,
} from "../app/modules/settings/settings.repository.server";
import { LOCATIONS_QUERY } from "../app/modules/shopify/graphql/queries";

vi.mock("../app/shopify.server", () => ({ authenticate: { admin: vi.fn() } }));
vi.mock("../app/modules/settings/settings.repository.server", () => ({
  getLocationSettings: vi.fn(),
  saveLocationSettings: vi.fn(),
  saveLowStockThreshold: vi.fn(),
}));

const shop = "settings-fixture.myshopify.com";
const locationGid = "gid://shopify/Location/1";
const selected = { locationGid, locationName: "Warehouse" };
let graphql: ReturnType<typeof vi.fn<AdminGraphqlClient>>;

beforeEach(() => {
  vi.resetAllMocks();
  graphql = vi.fn<AdminGraphqlClient>();
  const context = {
    admin: { graphql },
    session: new Session({ id: "fixture", shop, state: "", isOnline: false }),
  };
  vi.mocked(authenticate.admin).mockResolvedValue(
    context as unknown as Awaited<ReturnType<typeof authenticate.admin>>,
  );
  vi.mocked(getLocationSettings).mockResolvedValue(null);
  vi.mocked(saveLocationSettings).mockResolvedValue(selected);
});

function locationsResponse() {
  return new Response(
    JSON.stringify({
      data: {
        locations: {
          nodes: [
            { id: locationGid, name: "Warehouse", isActive: true },
            {
              id: "gid://shopify/Location/2",
              name: "Inactive",
              isActive: false,
            },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    }),
  );
}

const loadArgs = () =>
  ({
    request: new Request(
      "https://app.test/app/settings?shop=attacker.myshopify.com",
    ),
    params: {},
    context: {},
  }) as LoaderFunctionArgs;

it("threshold action trusts only the authenticated shop and rejects duplicate/malformed values before persistence", async () => {
  vi.mocked(saveLowStockThreshold).mockResolvedValue({ lowStockThreshold: 7 });
  const submit = (form: URLSearchParams) =>
    thresholdAction({
      ...loadArgs(),
      request: new Request("https://app.test/app/settings/threshold", {
        method: "POST",
        body: form,
      }),
    } as ActionFunctionArgs);
  expect(
    (
      await submit(
        new URLSearchParams({
          lowStockThreshold: "7",
          shop: "attacker.myshopify.com",
        }),
      )
    ).data.saved,
  ).toBe(true);
  expect(saveLowStockThreshold).toHaveBeenCalledExactlyOnceWith(shop, 7);
  for (const form of [
    new URLSearchParams("lowStockThreshold=1&lowStockThreshold=2"),
    new URLSearchParams("lowStockThreshold=-1"),
  ]) {
    const response = await submit(form);
    expect(response.init?.status).toBe(400);
  }
  expect(saveLowStockThreshold).toHaveBeenCalledTimes(1);
});
function actionArgs(
  form: URLSearchParams | FormData = new URLSearchParams({ locationGid }),
) {
  return {
    ...loadArgs(),
    request: new Request("https://app.test/app/settings", {
      method: "POST",
      body: form,
    }),
  } as ActionFunctionArgs;
}

describe("location loader/action with the real GraphQL service", () => {
  it("authenticates, reads only the session shop and loads active Shopify locations", async () => {
    graphql.mockResolvedValueOnce(locationsResponse());
    vi.mocked(getLocationSettings).mockResolvedValue({
      ...selected,
      lastSyncedAt: null,
      lowStockThreshold: 5,
      telegramChatId: null,
    });
    const args = loadArgs();
    expect(await loader(args)).toEqual({
      selected: {
        ...selected,
        lastSyncedAt: null,
        lowStockThreshold: 5,
        telegramChatId: null,
      },
      locations: [selected],
      error: null,
      botConfigured: Boolean(process.env.TELEGRAM_BOT_TOKEN?.trim()),
    });
    expect(authenticate.admin).toHaveBeenCalledWith(args.request);
    expect(getLocationSettings).toHaveBeenCalledWith(shop);
    expect(graphql).toHaveBeenCalledWith(LOCATIONS_QUERY, {
      variables: { first: 50, after: null },
      tries: 1,
    });
  });

  it("retains the saved selection when Shopify is unavailable", async () => {
    graphql.mockRejectedValueOnce(new Error("network unavailable"));
    vi.mocked(getLocationSettings).mockResolvedValue({
      ...selected,
      lastSyncedAt: null,
      lowStockThreshold: 5,
      telegramChatId: null,
    });
    expect(await loader(loadArgs())).toMatchObject({
      selected,
      locations: [],
      error: expect.any(String),
    });
  });

  it("rejects locations missing from the fresh active list, including inactive or foreign IDs", async () => {
    for (const invalid of [
      "gid://shopify/Location/2",
      "gid://shopify/Location/foreign",
    ]) {
      graphql.mockResolvedValueOnce(locationsResponse());
      const result = await action(
        actionArgs(new URLSearchParams({ locationGid: invalid })),
      );
      expect(result.init?.status).toBe(400);
    }
    expect(saveLocationSettings).not.toHaveBeenCalled();
  });

  it("uses Shopify's location name and the session shop, ignoring forged form fields", async () => {
    graphql.mockResolvedValueOnce(locationsResponse());
    const args = actionArgs(
      new URLSearchParams({
        locationGid,
        locationName: "Forged",
        shopDomain: "victim.myshopify.com",
      }),
    );
    const result = await action(args);
    expect(result.data).toEqual({ saved: true, error: null });
    expect(authenticate.admin).toHaveBeenCalledWith(args.request);
    expect(saveLocationSettings).toHaveBeenCalledExactlyOnceWith(
      shop,
      selected,
    );
  });

  it.each([
    new URLSearchParams(),
    new URLSearchParams({ locationGid: "  " }),
    new URLSearchParams([
      ["locationGid", locationGid],
      ["locationGid", "second"],
    ]),
  ])(
    "requires exactly one nonempty location before calling Shopify",
    async (form) => {
      const result = await action(actionArgs(form));
      expect(result.init?.status).toBe(400);
      expect(graphql).not.toHaveBeenCalled();
      expect(saveLocationSettings).not.toHaveBeenCalled();
    },
  );

  it("does not write when the validation query fails", async () => {
    graphql.mockRejectedValueOnce(new Error("API unavailable"));
    const result = await action(actionArgs());
    expect(result.init?.status).toBe(503);
    expect(saveLocationSettings).not.toHaveBeenCalled();
  });

  it("rejects an uploaded file in place of the location ID", async () => {
    const form = new FormData();
    form.append("locationGid", new Blob([locationGid]), "location.txt");
    expect((await action(actionArgs(form))).init?.status).toBe(400);
    expect(graphql).not.toHaveBeenCalled();
    expect(saveLocationSettings).not.toHaveBeenCalled();
  });

  it("reports database failures without returning success", async () => {
    graphql.mockResolvedValueOnce(locationsResponse());
    vi.mocked(saveLocationSettings).mockRejectedValueOnce(
      new Error("database unavailable"),
    );
    expect((await action(actionArgs())).data).toMatchObject({
      saved: false,
      error: expect.any(String),
    });
  });

  it.each(["loader", "action"])(
    "preserves Shopify authentication responses in %s",
    async (kind) => {
      const denied = new Response(null, {
        status: 401,
        headers: { "X-Shopify-Retry-Invalid-Session-Request": "1" },
      });
      vi.mocked(authenticate.admin).mockRejectedValueOnce(denied);
      await expect(
        kind === "loader" ? loader(loadArgs()) : action(actionArgs()),
      ).rejects.toBe(denied);
      expect(getLocationSettings).not.toHaveBeenCalled();
      expect(saveLocationSettings).not.toHaveBeenCalled();
    },
  );

  it("does not swallow reauthorization from the GraphQL client", async () => {
    const denied = new Response(null, {
      status: 302,
      headers: { Location: "/auth" },
    });
    graphql.mockRejectedValueOnce(denied);
    await expect(loader(loadArgs())).rejects.toBe(denied);
  });
});

describe("location selection screen", () => {
  const render = (
    props: Partial<Parameters<typeof LocationSelection>[0]> = {},
  ) =>
    renderToStaticMarkup(
      createElement(LocationSelection, {
        locations: [selected],
        selected,
        error: null,
        saved: false,
        busy: false,
        onRetry: () => {},
        ...props,
      }),
    );

  it("renders one labelled single-select with the saved choice selected", () => {
    const html = render();
    expect(html).toContain('name="locationGid"');
    expect(html).toContain('for="locationGid"');
    expect(html).toContain(`value="${locationGid}" selected=""`);
    expect(html).not.toContain("multiple");
    expect(html).not.toContain('disabled="false"');
    expect(html).not.toContain('loading="false"');
  });

  it("renders loading and disables changes while saving/reloading", () => {
    expect(render({ busy: true })).toContain('disabled=""');
    expect(render({ busy: true })).toContain("s-spinner");
  });

  it("renders the empty state without a save button", () => {
    const html = render({ locations: [], selected: null });
    expect(html).toContain("No active locations");
    expect(html).not.toContain("Save location");
  });

  it("keeps the old selection visible on API failure and offers retry", () => {
    const html = render({ locations: [], error: "API unavailable" });
    expect(html).toContain("Warehouse");
    expect(html).toContain("API unavailable");
    expect(html).toContain("Reload locations");
  });

  it("warns when the saved location is no longer active", () => {
    expect(
      render({ selected: { locationGid: "removed", locationName: "Old" } }),
    ).toContain("Saved location is no longer available");
  });

  it("allows correcting and resubmitting after a validation error", () => {
    const html = render({
      error: "Choose an active location from this store.",
    });
    expect(html).toContain("Save location");
    expect(html).not.toContain('type="submit" disabled');
  });
});
