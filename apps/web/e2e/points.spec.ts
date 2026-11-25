import { POINTS_NAME } from "@padelloyalty/shared";
import { expect, test, type Page, type Route } from "@playwright/test";
import { API_URL, FakeAuthApi } from "./support/fake-auth-api";

// #6 Points balance on the member home. Runs on desktop and phone viewports,
// at the root and under the GitHub Pages base path. The API is the
// contract-checked fake (docs/api/points.md).
const EMAIL = "ana@example.com";
const KID = "kid@example.com";
const PASSWORD = "correct horse battery";
const BALANCE = `${API_URL}/points/balance`;

let api: FakeAuthApi;

test.beforeEach(async ({ page }) => {
  api = new FakeAuthApi();
  await api.install(page);
  await page.route("**/health", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({ status: "ok", database: "up", timestamp: new Date().toISOString() }),
    }),
  );
});

async function logIn(page: Page, email = EMAIL) {
  await page.goto("login/");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByTestId("account-email")).toHaveText(email);
}

const card = (page: Page) => page.getByTestId("points-balance");
const value = (page: Page) => page.getByTestId("points-balance-value");
const balanceCalls = () => api.calls.filter((c) => c === "GET /points/balance").length;

test("an active member sees their balance on the home screen", async ({ page }) => {
  api.addAccount(EMAIL, PASSWORD);
  api.points.set(EMAIL, 1250);
  await logIn(page);

  await expect(card(page)).toContainText(`Your ${POINTS_NAME}`);
  await expect(value(page)).toHaveText("1,250");
  await expect(card(page)).toContainText(POINTS_NAME);
  await expect(page.getByTestId("points-zero")).toHaveCount(0);
  // Balance first, at a glance: above the account panel.
  const balanceBox = await card(page).boundingBox();
  const accountBox = await page.getByTestId("account").boundingBox();
  expect(balanceBox!.y).toBeLessThan(accountBox!.y);
  await expectNoHorizontalOverflow(page);

  // Still there after a relaunch (session resumed from the stored refresh token).
  await page.reload();
  await expect(value(page)).toHaveText("1,250");
});

test("a member with no points sees 0 and how to earn them", async ({ page }) => {
  api.addAccount(EMAIL, PASSWORD);
  await logIn(page);
  await expect(value(page)).toHaveText("0");
  await expect(page.getByTestId("points-zero")).toContainText(`No ${POINTS_NAME} yet`);
});

test("shows a loading state until the balance arrives", async ({ page }) => {
  api.addAccount(EMAIL, PASSWORD);
  api.points.set(EMAIL, 40);
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route(BALANCE, async (route) => {
    if (route.request().method() === "GET") await gate;
    await route.fallback();
  });
  await logIn(page);

  await expect(card(page)).toHaveAttribute("aria-busy", "true");
  await expect(card(page)).toContainText("Loading your balance");
  release();
  await expect(value(page)).toHaveText("40");
  await expect(card(page)).toHaveAttribute("aria-busy", "false");
});

test("shows an error with a retry when the balance can't be loaded", async ({ page }) => {
  api.addAccount(EMAIL, PASSWORD);
  api.points.set(EMAIL, 75);
  let failNext = true;
  await page.route(BALANCE, async (route: Route) => {
    if (route.request().method() === "GET" && failNext) {
      failNext = false;
      return route.abort("internetdisconnected");
    }
    return route.fallback();
  });
  await logIn(page);

  await expect(page.getByTestId("points-error")).toContainText(`couldn't load your ${POINTS_NAME}`);
  await expect(value(page)).toHaveCount(0);
  await page.getByTestId("points-error").getByRole("button", { name: "Try again" }).click();
  await expect(value(page)).toHaveText("75");
  await expect(page.getByTestId("points-error")).toHaveCount(0);
});

test("keeps the last balance if a refresh fails", async ({ page }) => {
  api.addAccount(EMAIL, PASSWORD);
  api.points.set(EMAIL, 300);
  await logIn(page);
  await expect(value(page)).toHaveText("300");

  api.overrides.set("/points/balance", {
    status: 500,
    body: { error: { code: "internal_error", message: "Something went wrong." } },
  });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByTestId("points-refresh-error")).toBeVisible();
  await expect(value(page)).toHaveText("300");

  api.points.set(EMAIL, 320);
  await page.getByTestId("points-refresh-error").getByRole("button", { name: "Try again" }).click();
  await expect(value(page)).toHaveText("320");
  await expect(page.getByTestId("points-refresh-error")).toHaveCount(0);
});

test("refreshes when the app regains focus or becomes visible", async ({ page }) => {
  api.addAccount(EMAIL, PASSWORD);
  api.points.set(EMAIL, 100);
  await logIn(page);
  await expect(value(page)).toHaveText("100");

  // An earn happened elsewhere (e.g. checked in at reception), then the member comes back.
  api.points.set(EMAIL, 150);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(value(page)).toHaveText("150");

  api.points.set(EMAIL, 90);
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(value(page)).toHaveText("90");
});

test("refreshes after an earn or redeem signals a change (notifyPointsChanged)", async ({
  page,
}) => {
  api.addAccount(EMAIL, PASSWORD);
  api.points.set(EMAIL, 100);
  await logIn(page);
  await expect(value(page)).toHaveText("100");
  const before = balanceCalls();

  // What #7 (earn) and #15 (redeem) do after a successful response.
  api.points.set(EMAIL, 0);
  await page.evaluate(() => window.dispatchEvent(new Event("padelloyalty:points-changed")));
  await expect(value(page)).toHaveText("0");
  expect(balanceCalls()).toBe(before + 1);
});

test("another tab's earn or redeem refreshes this tab", async ({ page, context }) => {
  api.addAccount(EMAIL, PASSWORD);
  api.points.set(EMAIL, 10);
  await logIn(page);
  await expect(value(page)).toHaveText("10");

  const other = await context.newPage();
  await api.install(other);
  await other.goto("./");
  await expect(other.getByTestId("points-balance-value")).toHaveText("10");

  api.points.set(EMAIL, 60);
  await other.evaluate(() => {
    // notifyPointsChanged() in the other tab: its own window event plus a broadcast.
    const channel = new BroadcastChannel("padelloyalty-points");
    channel.postMessage({ type: "changed", from: "another-tab" });
    channel.close();
  });
  await expect(value(page)).toHaveText("60");
});

test("a rejected access token is refreshed once and the balance still loads", async ({ page }) => {
  // Regression: another tab refreshing the session rotates this tab's access
  // token, so this tab's next balance request gets 401.
  api.addAccount(EMAIL, PASSWORD);
  api.points.set(EMAIL, 42);
  await logIn(page);
  await expect(value(page)).toHaveText("42");
  await page.waitForLoadState("networkidle");
  const callsBefore = api.calls.length;

  api.points.set(EMAIL, 50);
  api.overrides.set("/points/balance", {
    status: 401,
    body: { error: { code: "unauthorized", message: "You need to log in to do that." } },
  });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(value(page)).toHaveText("50");
  await expect(page.getByTestId("points-refresh-error")).toHaveCount(0);
  expect(api.calls.slice(callsBefore)).toEqual([
    "GET /points/balance",
    "POST /auth/refresh",
    "GET /points/balance",
  ]);
});

test("a revoked session shows the logged-out home, not a balance error", async ({ page }) => {
  api.addAccount(EMAIL, PASSWORD);
  await logIn(page);
  await expect(value(page)).toHaveText("0");

  api.overrides.set("/points/balance", {
    status: 401,
    body: { error: { code: "unauthorized", message: "You need to log in to do that." } },
  });
  api.overrides.set("/auth/refresh", {
    status: 401,
    body: { error: { code: "invalid_refresh_token", message: "Your session has ended." } },
  });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("link", { name: "Log in" })).toBeVisible();
  await expect(card(page)).toHaveCount(0);
});

test("pending accounts see their pending state instead of a balance", async ({ page }) => {
  api.addAccount(EMAIL, PASSWORD, false);
  await logIn(page);
  await expect(page.getByTestId("verify-reminder")).toBeVisible();
  await expect(card(page)).toHaveCount(0);

  api.addPendingMinor(KID, PASSWORD, `${new Date().getFullYear() - 14}-06-15`, "mum@example.com");
  await page.getByRole("button", { name: "Log out" }).click();
  await logIn(page, KID);
  await expect(page.getByTestId("consent-pending")).toBeVisible();
  await expect(card(page)).toHaveCount(0);

  expect(api.calls).not.toContain("GET /points/balance");
});

test("logged-out visitors see no balance", async ({ page }) => {
  await page.goto("./");
  await expect(page.getByRole("link", { name: "Log in" })).toBeVisible();
  await expect(card(page)).toHaveCount(0);
  expect(api.calls).not.toContain("GET /points/balance");
});

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}
