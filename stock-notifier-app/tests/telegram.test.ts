import type { ActionFunctionArgs } from "react-router";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  formatInventoryNotification,
  parseTelegramChatId,
  sendTelegramMessage,
} from "../app/modules/notifications/telegram.server";
import { action } from "../app/routes/app.settings.telegram";
import { authenticate } from "../app/shopify.server";
import {
  getLocationSettings,
  saveTelegramChatId,
} from "../app/modules/settings/settings.repository.server";

vi.mock("../app/shopify.server", () => ({ authenticate: { admin: vi.fn() } }));
vi.mock("../app/modules/settings/settings.repository.server", () => ({
  getLocationSettings: vi.fn(),
  saveTelegramChatId: vi.fn(),
}));
const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "unit-test-only-token");
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

test("sendMessage uses plain text with no parsing and confirms success", async () => {
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ ok: true, result: { message_id: 1 } })),
  );
  await sendTelegramMessage("-100123", "<tag> & _special_ 🚨");
  const [url, options] = fetchMock.mock.calls[0];
  expect(url).toBe(
    "https://api.telegram.org/botunit-test-only-token/sendMessage",
  );
  expect(JSON.parse(options!.body as string)).toEqual({
    chat_id: "-100123",
    text: "<tag> & _special_ 🚨",
  });
  expect(options?.signal).toBeInstanceOf(AbortSignal);
});
test.each([
  [429, { ok: false, parameters: { retry_after: 60 } }, true, 60000],
  [503, { ok: false }, true, 0],
  [200, { ok: false, error_code: 500 }, true, 0],
  [200, { ok: false, error_code: 403 }, false, 0],
  [400, { ok: false, error_code: 400 }, false, 0],
] as const)(
  "HTTP %s / API rejection exposes safe durable-retry metadata",
  async (status, body, retryable, retryAfterMs) => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(body), { status }));
    await expect(sendTelegramMessage("1", "test")).rejects.toMatchObject({
      retryable,
      retryAfterMs,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  },
);
test("missing token sends nothing; transport errors never expose token or fetch URL", async () => {
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
  await expect(sendTelegramMessage("1", "test")).rejects.toThrow(
    "not configured",
  );
  expect(fetchMock).not.toHaveBeenCalled();
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "unit-test-only-token");
  fetchMock.mockRejectedValue(
    new Error("https://api.telegram.org/botunit-test-only-token/sendMessage"),
  );
  await expect(sendTelegramMessage("1", "test")).rejects.toMatchObject({
    retryable: true,
    message: "Telegram request timed out or could not be completed.",
  });
});
test("in-flight timeout aborts the request and is retryable", async () => {
  const controller = new AbortController();
  vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
  fetchMock.mockImplementation(
    (_url, options) =>
      new Promise((_resolve, reject) => {
        options!.signal!.addEventListener(
          "abort",
          () => reject(new Error("abort")),
          { once: true },
        );
      }),
  );
  const sent = sendTelegramMessage("1", "test");
  controller.abort();
  await expect(sent).rejects.toMatchObject({ retryable: true });
  expect(AbortSignal.timeout).toHaveBeenCalledWith(2000);
});
test("Chat ID validation accepts private/groups and rejects malformed or out-of-range IDs", () => {
  expect(parseTelegramChatId(" -100123 ")).toBe("-100123");
  expect(parseTelegramChatId("123")).toBe("123");
  expect(parseTelegramChatId(" ")).toBeNull();
  for (const value of [
    null,
    "0",
    "-0",
    "1.2",
    "@username",
    "4503599627370496",
    "1e3",
  ])
    expect(() => parseTelegramChatId(value)).toThrow();
});
test("message keeps mandatory fields, nullable SKU and multiple variants, truncating safely at Telegram's limit", () => {
  const message = formatInventoryNotification({
    inventoryItemGid: "gid://shopify/InventoryItem/1",
    locationName: "Main",
    locationGid: "loc",
    sku: null,
    quantity: -2,
    threshold: 5,
    variants: [
      { productTitle: "A <b>", variantTitle: "Blue & Red" },
      { productTitle: "B", variantTitle: "🚨".repeat(5000) },
    ],
  });
  for (const value of [
    "SKU: N/A",
    "Location: Main",
    "Available Quantity: -2",
    "Threshold: 5",
    "A <b> / Blue & Red",
    "B /",
  ])
    expect(message).toContain(value);
  expect(message.length).toBeLessThanOrEqual(4096);
  expect(
    formatInventoryNotification({
      inventoryItemGid: "item",
      locationName: null,
      locationGid: "location",
      sku: null,
      quantity: 0,
      threshold: 0,
      variants: null,
    }),
  ).toContain("Unavailable");
});

test("Settings actions use authenticated shop; test uses persisted Chat ID and preserves auth rejection", async () => {
  const auth = {
    session: { shop: "trusted.myshopify.com" },
  } as unknown as Awaited<ReturnType<typeof authenticate.admin>>;
  vi.mocked(authenticate.admin).mockResolvedValue(auth);
  const submit = (form: URLSearchParams) =>
    action({
      request: new Request(
        "https://app.test/app/settings/telegram?shop=attacker",
        { method: "POST", body: form },
      ),
    } as ActionFunctionArgs);
  await submit(
    new URLSearchParams({
      intent: "save",
      telegramChatId: "123",
      shopDomain: "attacker",
    }),
  );
  expect(saveTelegramChatId).toHaveBeenCalledWith(
    "trusted.myshopify.com",
    "123",
  );
  vi.mocked(getLocationSettings).mockResolvedValue({
    locationGid: null,
    locationName: null,
    lastSyncedAt: null,
    lowStockThreshold: 5,
    telegramChatId: "456",
  });
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true })));
  expect(
    (
      await submit(
        new URLSearchParams({ intent: "test", telegramChatId: "attacker" }),
      )
    ).data.error,
  ).toBeNull();
  expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string).chat_id).toBe(
    "456",
  );
  expect(
    (
      await submit(
        new URLSearchParams("intent=save&telegramChatId=1&telegramChatId=2"),
      )
    ).init?.status,
  ).toBe(400);
  expect((await submit(new URLSearchParams("intent=other"))).init?.status).toBe(
    400,
  );
  vi.mocked(authenticate.admin).mockRejectedValue(
    new Response(null, { status: 401 }),
  );
  await expect(
    submit(new URLSearchParams({ intent: "test" })),
  ).rejects.toMatchObject({ status: 401 });
});
