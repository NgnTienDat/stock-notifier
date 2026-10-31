import { cwd } from "node:process";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    env: { DATABASE_URL: loadEnv("test", cwd(), "").DATABASE_URL },
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
