import { defineConfig } from "vite";

export default defineConfig({
  build: {
    ssr: "app/workers/telegram.worker.server.ts",
    target: "node22",
    outDir: "build/worker",
    emptyOutDir: true,
    rollupOptions: { output: { entryFileNames: "telegram.worker.js" } },
  },
});
