import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { readDotEnv } from "./test/support/test-env.js";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Vitest does not load .env itself. Variables already set in the shell win.
    env: readDotEnv(fileURLToPath(new URL(".env", import.meta.url))),
    // Integration tests share one test database; run files one at a time.
    fileParallelism: false,
    testTimeout: 15_000,
    hookTimeout: 30_000,
  },
});
