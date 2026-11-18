import { expect, test } from "@playwright/test";
import { resolveApiUrl } from "../src/lib/config";

// The smoke tests stub `**/health`, which also matches a same-origin
// `/health`. This checks the app calls the API at the configured base URL.
const timestamp = "2026-11-18T10:00:00.000Z";

for (const path of ["./", "admin/"]) {
  test(`${path} calls GET {NEXT_PUBLIC_API_URL}/health`, async ({ page, baseURL }) => {
    const requested: string[] = [];
    await page.route("**/health", (route) => {
      requested.push(route.request().url());
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify({ status: "ok", database: "up", timestamp }),
      });
    });

    await page.goto(path);
    await expect(page.getByTestId("api-status-api")).toHaveText("Online");

    const shownApiUrl = (await page.getByTestId("api-status").locator("p").textContent()) ?? "";
    expect(requested).toEqual([`${shownApiUrl}/health`]);
    expect(new URL(requested[0] ?? "").origin).not.toBe(new URL(baseURL ?? "").origin);
    if (process.env.NEXT_PUBLIC_API_URL !== undefined) {
      expect(shownApiUrl).toBe(resolveApiUrl(process.env.NEXT_PUBLIC_API_URL));
    }
  });
}
