import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("vite", () => ({
  loadEnv: vi.fn(() => {
    // Simulate dotenv expansion replacing empty env values from a real .env file.
    process.env.SHOPIFY_APP_URL = "https://dotenv.example.test";
    return { SHOPIFY_APP_URL: "https://dotenv.example.test" };
  }),
}));
vi.mock("../app/db.server", () => {
  throw new Error("Missing configuration must stop before loading Prisma");
});

const originalArgv = process.argv;
const originalExitCode = process.exitCode;
beforeEach(() => {
  vi.resetModules();
  process.argv = [...originalArgv, "--inventory"];
  process.exitCode = undefined;
  vi.stubEnv("SHOPIFY_API_KEY", "fixture-key");
  vi.stubEnv("SHOPIFY_API_SECRET", "fixture-secret");
  vi.stubEnv("SHOPIFY_APP_URL", "https://worker.example.test");
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

test.each(["SHOPIFY_API_KEY", "SHOPIFY_API_SECRET", "SHOPIFY_APP_URL"])(
  "inventory worker reports missing %s without SDK/database work or exposing secrets",
  async (key) => {
    vi.stubEnv(key, "");
    await import("../app/workers/telegram.worker.server");
    expect(process.exitCode).toBe(1);
    const output = vi.mocked(console.error).mock.calls.flat().join(" ");
    expect(output).toContain(key);
    expect(output).not.toContain("fixture-secret");
    expect(output).not.toContain("fixture-key");
  },
);

test.each(["not-a-url", "ftp://worker.example.test"])(
  "inventory worker rejects invalid app URL %s before startup",
  async (url) => {
    vi.stubEnv("SHOPIFY_APP_URL", url);
    await import("../app/workers/telegram.worker.server");
    expect(process.exitCode).toBe(1);
    expect(console.error).toHaveBeenCalledWith(
      "Inventory worker requires a valid http(s) SHOPIFY_APP_URL.",
    );
  },
);
