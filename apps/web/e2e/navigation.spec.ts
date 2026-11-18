import { expect, test, type Page } from "@playwright/test";
import { resolveBasePath } from "../src/lib/base-path";

// Runs at the root (Capacitor/local build) and under NEXT_PUBLIC_BASE_PATH
// (the GitHub Pages build, e.g. /PadelLoyalty/). Every page, asset and link
// must stay inside the base path.
const basePath = resolveBasePath(process.env.NEXT_PUBLIC_BASE_PATH);
const timestamp = "2026-11-18T10:00:00.000Z";

async function stubHealthyApi(page: Page) {
  await page.route("**/health", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({ status: "ok", database: "up", timestamp }),
    }),
  );
}

for (const path of ["./", "admin/"]) {
  test(`${path} loads every same-origin asset from under the base path`, async ({
    page,
    baseURL,
  }) => {
    const origin = new URL(baseURL ?? "").origin;
    const sameOrigin: { url: string; status: number }[] = [];
    page.on("response", (response) => {
      if (new URL(response.url()).origin === origin) {
        sameOrigin.push({ url: response.url(), status: response.status() });
      }
    });
    // Next's router aborts some of its own link prefetches (net::ERR_ABORTED);
    // any other network failure is a broken asset.
    const failed: string[] = [];
    page.on("requestfailed", (request) => {
      const error = request.failure()?.errorText ?? "";
      if (error !== "net::ERR_ABORTED") failed.push(`${request.url()} ${error}`);
    });
    await stubHealthyApi(page);

    await page.goto(path);
    // "Online" needs the client-side JS from /_next to have loaded and run.
    await expect(page.getByTestId("api-status-api")).toHaveText("Online");
    await page.waitForLoadState("networkidle");

    expect(failed).toEqual([]);
    expect(sameOrigin.length).toBeGreaterThan(1);
    expect(sameOrigin.filter((r) => r.status >= 400)).toEqual([]);
    for (const { url } of sameOrigin) {
      expect(new URL(url).pathname, url).toMatch(new RegExp(`^${basePath}/`));
    }
  });
}

test("the back office links to the member home inside the base path", async ({ page }) => {
  await stubHealthyApi(page);
  await page.goto("admin/");

  await page.getByRole("link", { name: "Member app" }).click();

  await expect(page.getByRole("heading", { level: 1, name: "Welcome" })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe(`${basePath}/`);
});

test("reloading a deep link serves the same page", async ({ page }) => {
  await stubHealthyApi(page);
  await page.goto("admin/");
  await page.reload();

  await expect(page.getByRole("heading", { level: 1, name: "Back office" })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe(`${basePath}/admin/`);
  await expect(page.getByTestId("api-status-api")).toHaveText("Online");
});

test("a deep link without the trailing slash ends up on the page", async ({ page }) => {
  await stubHealthyApi(page);
  await page.goto("admin");

  await expect(page.getByRole("heading", { level: 1, name: "Back office" })).toBeVisible();
  // GitHub Pages (and e2e/serve-static.mjs) redirect to admin/; `serve` at the
  // root answers admin directly.
  expect(new URL(page.url()).pathname).toMatch(new RegExp(`^${basePath}/admin/?$`));
});
