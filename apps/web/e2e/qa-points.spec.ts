import { POINTS_NAME } from "@padelloyalty/shared";
import { expect, test, type Page } from "@playwright/test";
import { API_URL, FakeAuthApi } from "./support/fake-auth-api";

// QA (Quan) e2e for #6, on top of points.spec.ts: member switching, large and
// unusual balances, retry after an error, an account that stops being active,
// and the provisional points name. Desktop and phone, root and base path.
const ANA = "ana@example.com";
const BEN = "ben@example.com";
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

async function logIn(page: Page, email = ANA) {
  await page.goto("login/");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByTestId("account-email")).toHaveText(email);
}

const card = (page: Page) => page.getByTestId("points-balance");
const value = (page: Page) => page.getByTestId("points-balance-value");

test("after logging out and in as another member, only the new member's balance shows", async ({
  page,
}) => {
  api.addAccount(ANA, PASSWORD);
  api.addAccount(BEN, PASSWORD);
  api.points.set(ANA, 4321);
  api.points.set(BEN, 7);
  await logIn(page, ANA);
  await expect(value(page)).toHaveText("4,321");

  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page.getByRole("link", { name: "Log in" })).toBeVisible();

  // Hold Ben's balance response so we can see what shows meanwhile.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(BALANCE, async (route) => {
    await held;
    await route.fallback();
  });
  await logIn(page, BEN);
  await expect(card(page)).toHaveAttribute("data-state", "loading");
  await expect(page.getByText("4,321")).toHaveCount(0);
  release();
  await expect(value(page)).toHaveText("7");
  await expect(page.getByText("4,321")).toHaveCount(0);
});

test("a very large balance is shown in full and fits on the screen", async ({ page }) => {
  api.addAccount(ANA, PASSWORD);
  api.points.set(ANA, 2_200_000_000);
  await logIn(page);
  await expect(value(page)).toHaveText("2,200,000,000");
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  const box = await card(page).boundingBox();
  const valueBox = await value(page).boundingBox();
  expect(valueBox!.x + valueBox!.width).toBeLessThanOrEqual(box!.x + box!.width + 1);
});

test("the client shows whatever balance the server returns, without computing it", async ({
  page,
}) => {
  api.addAccount(ANA, PASSWORD);
  api.points.set(ANA, -50);
  await logIn(page);
  await expect(value(page)).toHaveText(/^[-−]50$/);
  await expect(page.getByTestId("points-zero")).toHaveCount(0);
});

test("after an error, Try again loads the balance", async ({ page }) => {
  api.addAccount(ANA, PASSWORD);
  api.points.set(ANA, 300);
  api.overrides.set("/points/balance", {
    status: 500,
    body: { error: { code: "internal_error", message: "Something went wrong. Please try again." } },
  });
  await logIn(page);
  await expect(page.getByTestId("points-error")).toContainText(POINTS_NAME);
  await expect(value(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(value(page)).toHaveText("300");
  await expect(page.getByTestId("points-error")).toHaveCount(0);
});

test("a network failure on the first load shows the error, not a zero balance", async ({
  page,
}) => {
  api.addAccount(ANA, PASSWORD);
  api.points.set(ANA, 300);
  await page.route(BALANCE, (route) =>
    route.request().method() === "OPTIONS" ? route.fallback() : route.abort("failed"),
  );
  await logIn(page);
  await expect(page.getByTestId("points-error")).toBeVisible();
  await expect(value(page)).toHaveCount(0);
  await expect(page.getByTestId("points-zero")).toHaveCount(0);
});

test("if the account stops being active, the balance goes away on the next refresh", async ({
  page,
}) => {
  const account = api.addAccount(ANA, PASSWORD);
  api.points.set(ANA, 900);
  await logIn(page);
  await expect(value(page)).toHaveText("900");

  account.user = { ...account.user, status: "pending_verification", emailVerified: false };
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(card(page)).toHaveCount(0);
  await expect(page.getByTestId("verify-reminder")).toBeVisible();
  await expect(page.getByText("900")).toHaveCount(0);
});

test("the home screen uses the provisional points name only", async ({ page }) => {
  api.addAccount(ANA, PASSWORD);
  api.points.set(ANA, 1);
  await logIn(page);
  await expect(value(page)).toHaveText("1");
  await expect(card(page)).toContainText(`Your ${POINTS_NAME}`);
  const text = await page.locator("body").innerText();
  expect(text).not.toMatch(/almas/i);
});
