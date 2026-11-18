import { expect, test, type Page } from "@playwright/test";

// The smoke test does not need a running API: calls to /health are stubbed so
// the test checks that the web app calls the API and renders what it returns.
async function stubHealth(page: Page, status: number, body: unknown) {
  await page.route("**/health", (route) =>
    route.fulfill({
      status,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify(body),
    }),
  );
}

const timestamp = "2026-11-18T10:00:00.000Z";

test("member home loads and shows a healthy API", async ({ page }) => {
  await stubHealth(page, 200, { status: "ok", database: "up", timestamp });

  await page.goto("/");

  await expect(page.getByRole("heading", { level: 1, name: "Welcome" })).toBeVisible();
  await expect(page.getByTestId("api-status-api")).toHaveText("Online");
  await expect(page.getByTestId("api-status-database")).toHaveText("Up");
});

test("staff back office placeholder loads at /admin", async ({ page }) => {
  await stubHealth(page, 200, { status: "ok", database: "up", timestamp });

  await page.goto("/admin");

  await expect(page.getByRole("heading", { level: 1, name: "Back office" })).toBeVisible();
  await expect(page.getByTestId("api-status-api")).toHaveText("Online");
});

test("shows the database as down when the API reports it", async ({ page }) => {
  await stubHealth(page, 503, { status: "degraded", database: "down", timestamp });

  await page.goto("/");

  await expect(page.getByTestId("api-status-api")).toHaveText("Online");
  await expect(page.getByTestId("api-status-database")).toHaveText("Down");
});

test("shows the API as unreachable when the request fails", async ({ page }) => {
  await page.route("**/health", (route) => route.abort("connectionrefused"));

  await page.goto("/");

  await expect(page.getByTestId("api-status-api")).toHaveText("API unreachable");
});

test("gives up on an API that never answers", async ({ page }) => {
  // Accept the request but never respond (like a wrong LAN address that hangs).
  await page.route("**/health", () => {});

  await page.goto("/");

  await expect(page.getByTestId("api-status-api")).toHaveText("Checking…");
  await expect(page.getByTestId("api-status-api")).toHaveText(
    "API unreachable (no response after 5s)",
    { timeout: 10_000 },
  );
  await expect(page.getByTestId("api-status-database")).toHaveText("Unknown");
});

test("layout fits the viewport without horizontal scrolling", async ({ page }) => {
  await stubHealth(page, 200, { status: "ok", database: "up", timestamp });

  for (const path of ["/", "/admin"]) {
    await page.goto(path);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `horizontal overflow on ${path}`).toBeLessThanOrEqual(0);
  }
});
