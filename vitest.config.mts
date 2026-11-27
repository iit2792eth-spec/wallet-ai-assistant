import os from "node:os";
import path from "node:path";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

export default defineConfig(({ mode }) => ({
  resolve: { alias: { "@": path.resolve(import.meta.dirname) } },
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    environment: "node",
    testTimeout: 20_000,
    // Same .env files as Next.js, so AI_TRACING and LANGSMITH_* apply to tests too.
    env: {
      ...loadEnv(mode, process.cwd(), ""),
      // Tests never write to the real audit log.
      AUDIT_LOG_PATH: path.join(os.tmpdir(), "wallet-access-layer-test-audit.log"),
    },
  },
}));
