import { POINTS_NAME } from "@padelloyalty/shared";
import { expect, test, type Page } from "@playwright/test";
import { resolveBasePath } from "../src/lib/base-path";
import { FakeAuthApi } from "./support/fake-auth-api";

// #1 Sign up / log in. Runs on desktop and phone viewports, at the root and
// under the GitHub Pages base path. The API is the contract-checked fake.
const basePath = resolveBasePath(process.env.NEXT_PUBLIC_BASE_PATH);
const EMAIL = "ana@example.com";
const PASSWORD = "correct horse battery";

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

async function logIn(page: Page, email = EMAIL, password = PASSWORD) {
  await page.goto("login/");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Log in" }).click();
}

test("sign up, verify the email, log in, stay logged in after a relaunch, log out", async ({
  page,
}) => {
  await page.goto("./");
  await page.getByRole("link", { name: "Sign up" }).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe(`${basePath}/signup/`);
  await expect(page.getByText(POINTS_NAME, { exact: false }).first()).toBeVisible();

  await page.getByLabel("Email").fill(" Ana@Example.com ");
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByLabel("Date of birth").fill("1990-04-15"); // #3: required for everyone
  await page.getByRole("button", { name: "Sign up" }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  await expect(page.getByTestId("signup-done")).toContainText(EMAIL);

  await page.goto(api.linkPath(EMAIL, "verify_email"));
  await expect(page.getByTestId("verify-success")).toBeVisible();
  // The token is removed from the address bar once used.
  await expect.poll(() => new URL(page.url()).hash).toBe("");
  await page.getByRole("link", { name: "Log in" }).click();

  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByTestId("account-email")).toHaveText(EMAIL);
  await expect.poll(() => new URL(page.url()).pathname).toBe(`${basePath}/`);
  await expect(page.getByTestId("verify-reminder")).toHaveCount(0);

  // Relaunch: a fresh page load resumes the session from the stored refresh token.
  await page.reload();
  await expect(page.getByTestId("account-email")).toHaveText(EMAIL);
  expect(api.calls).toContain("POST /auth/refresh");

  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page.getByRole("link", { name: "Log in" })).toBeVisible();
  expect(api.calls).toContain("POST /auth/logout");
  await page.reload();
  await expect(page.getByRole("link", { name: "Log in" })).toBeVisible();
});

test("keeps only the refresh token in storage; the access token stays in memory", async ({
  page,
}) => {
  api.addAccount(EMAIL, PASSWORD);
  await logIn(page);
  await expect(page.getByTestId("account-email")).toHaveText(EMAIL);

  const stored = await page.evaluate(() => ({ ...window.localStorage }));
  expect(Object.keys(stored)).toEqual(["padelloyalty.refreshToken"]);
  expect(stored["padelloyalty.refreshToken"]).toMatch(/^plr_/);
  expect(JSON.stringify(stored)).not.toContain("pla_");
  const cookies = await page.context().cookies();
  expect(cookies).toEqual([]);
});

test("checks the password rules before sending", async ({ page }) => {
  await page.goto("signup/");
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill("short");
  await page.getByRole("button", { name: "Sign up" }).click();

  await expect(page.getByText("Password must be at least 10 characters")).toBeVisible();
  await expect(page.getByLabel("Password")).toHaveAttribute("aria-invalid", "true");
  expect(api.calls).toEqual([]);
});

test("shows the same error for a wrong password and an unknown email", async ({ page }) => {
  api.addAccount(EMAIL, PASSWORD);

  await logIn(page, EMAIL, "wrong password");
  await expect(page.getByTestId("form-error")).toHaveText("Email or password is incorrect.");

  await logIn(page, "nobody@example.com", PASSWORD);
  await expect(page.getByTestId("form-error")).toHaveText("Email or password is incorrect.");
});

test("tells the user how long to wait when login is rate limited", async ({ page }) => {
  api.overrides.set("/auth/login", {
    status: 429,
    body: { error: { code: "rate_limited", message: "Too many attempts." } },
    headers: { "retry-after": "600" },
  });

  await logIn(page);

  await expect(page.getByTestId("form-error")).toHaveText(
    "Too many attempts. Please try again in 10 minutes.",
  );
});

test("an unverified member can log in, sees a reminder and can resend the link", async ({
  page,
}) => {
  api.addAccount(EMAIL, PASSWORD, false);
  await logIn(page);

  await expect(page.getByTestId("verify-reminder")).toBeVisible();
  await page.getByRole("button", { name: "Resend verification email" }).click();
  await expect(page.getByTestId("verify-reminder").getByRole("status").last()).toBeVisible();
  expect(api.emails.filter((e) => e.type === "verify_email")).toHaveLength(1);

  // Verifying in the same browser updates the home page.
  await page.goto(api.linkPath(EMAIL, "verify_email"));
  await expect(page.getByTestId("verify-success")).toBeVisible();
  await page.getByRole("link", { name: "Go to home" }).click();
  await expect(page.getByTestId("account-email")).toHaveText(EMAIL);
  await expect(page.getByTestId("verify-reminder")).toHaveCount(0);
});

test("a used or broken verification link says so", async ({ page }) => {
  await page.goto("verify-email/#token=ple_unknown");
  await expect(page.getByTestId("form-error")).toContainText("invalid or has expired");

  await page.goto("verify-email/");
  await expect(page.getByTestId("form-error")).toContainText("incomplete");
});

test("reset a forgotten password by emailed link", async ({ page }) => {
  api.addAccount(EMAIL, PASSWORD);
  await page.goto("login/");
  await page.getByRole("link", { name: "Forgot your password?" }).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe(`${basePath}/forgot-password/`);

  await page.getByLabel("Email").fill(EMAIL);
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.getByTestId("forgot-done")).toBeVisible();

  const link = api.linkPath(EMAIL, "password_reset");
  await page.goto(link);
  await page.getByLabel("New password", { exact: true }).fill("a brand new passphrase");
  await page.getByLabel("Repeat new password").fill("something else entirely");
  await page.getByRole("button", { name: "Set new password" }).click();
  await expect(page.getByText("The passwords don't match")).toBeVisible();

  await page.getByLabel("Repeat new password").fill("a brand new passphrase");
  await page.getByRole("button", { name: "Set new password" }).click();
  await expect(page.getByTestId("reset-done")).toBeVisible();

  await logIn(page, EMAIL, "a brand new passphrase");
  await expect(page.getByTestId("account-email")).toHaveText(EMAIL);

  // The link works once.
  await page.goto(link);
  await page.getByLabel("New password", { exact: true }).fill("yet another passphrase");
  await page.getByLabel("Repeat new password").fill("yet another passphrase");
  await page.getByRole("button", { name: "Set new password" }).click();
  await expect(page.getByTestId("form-error")).toContainText("invalid or has expired");
  await expect(page.getByRole("link", { name: "Get a new reset link" })).toBeVisible();
});

test("auth pages fit a phone screen without horizontal scrolling", async ({ page }) => {
  for (const path of [
    "login/",
    "signup/",
    "forgot-password/",
    "reset-password/#token=x",
    "verify-email/",
  ]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `horizontal overflow on ${path}`).toBeLessThanOrEqual(0);
  }
});
