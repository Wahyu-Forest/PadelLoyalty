import { defineConfig, devices } from "@playwright/test";
import { resolveBasePath } from "./src/lib/base-path";

const port = Number(process.env.E2E_PORT ?? 3100);
// With NEXT_PUBLIC_BASE_PATH set (the GitHub Pages build), the export is
// served under that path, e.g. http://localhost:3100/PadelLoyalty/.
const basePath = resolveBasePath(process.env.NEXT_PUBLIC_BASE_PATH);
const baseURL = `http://localhost:${port}${basePath}/`;
// Optional: run with an installed browser instead of Playwright's own build,
// e.g. E2E_BROWSER_CHANNEL=chrome when `playwright install` is not possible.
const channel = process.env.E2E_BROWSER_CHANNEL || undefined;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
    ...(channel ? { channel } : {}),
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    // Same suite at a phone viewport (Chromium), as the app ships to mobile via Capacitor.
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  // Serves the static export from `next build` (run `pnpm build` first;
  // `pnpm test:e2e` at the repo root does this via Turborepo).
  // With a base path, e2e/serve-static.mjs serves it the way GitHub Pages does.
  webServer: {
    command: basePath
      ? `node e2e/serve-static.mjs out ${port} ${basePath}`
      : `pnpm exec serve out --listen ${port} --no-clipboard`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
