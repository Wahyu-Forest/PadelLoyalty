import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.E2E_PORT ?? 3100);
const baseURL = `http://localhost:${port}`;
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
  webServer: {
    command: `pnpm exec serve out --listen ${port} --no-clipboard`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
