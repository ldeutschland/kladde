import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["apps/kladde/tests/**/*.test.ts"], environment: "node" },
});
