/**
 * QA (issue #1): sign up / log in UI flows, against the in-browser fake of the
 * auth API (e2e/support/fake-auth-api.ts), which follows docs/api/auth.md.
 *
 * Runs in both Playwright projects (desktop and Pixel 7) and, in CI, also under
 * the GitHub Pages base path. Pages are reached by following links from the
 * member home, except the email links, whose paths are part of the contract:
 * `{APP_URL}/verify-email/#token=…` and `{APP_URL}/reset-password/#token=…`.
 */
import { POINTS_NAME } from "@padelloyalty/shared";
import { expect, test, type Page } from "@playwright/test";
import { FakeAuthApi } from "./support/qa-fake-auth-api";

const PASSWORD = "correct horse battery";
const NEW_PASSWORD = "brand new password 42";

let api: FakeAuthApi;

test.beforeEach(async ({ page, baseURL }) => {
  api = new FakeAuthApi();
  await api.install(page, new URL(baseURL!).origin);
});

const uniqueEmail = () => `qa-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;

// Accessible names, loose enough not to depend on exact copy.
const emailField = (page: Page) => page.getByLabel(/^email/i);
const passwordField = (page: Page) => page.getByLabel(/^(new )?password$/i).first();
const signUpButton = (page: Page) =>
  page.getByRole("button", { name: /sign up|create (an )?account|register/i });
const logInButton = (page: Page) => page.getByRole("button", { name: /log ?in|sign ?in/i });
const logOutControl = (page: Page) => page.getByRole("button", { name: /log ?out|sign ?out/i });

async function openSignUp(page: Page) {
  await page.goto("./");
  await page
    .getByRole("link", { name: /sign up|create (an )?account|register|join/i })
    .first()
    .click();
  await expect(signUpButton(page)).toBeVisible();
}
async function openLogIn(page: Page) {
  await page.goto("./");
  await page
    .getByRole("link", { name: /log ?in|sign ?in/i })
    .first()
    .click();
  await expect(logInButton(page)).toBeVisible();
}
async function logInVia(page: Page, email: string, password = PASSWORD) {
  await openLogIn(page);
  await emailField(page).fill(email);
  await passwordField(page).fill(password);
  await logInButton(page).click();
  await expect(logOutControl(page)).toBeVisible();
}
/** Follows an emailed link the way the browser would (path is relative to the base path). */
async function followEmailLink(page: Page, path: "verify-email" | "reset-password", token: string) {
  await page.goto(`${path}/#token=${encodeURIComponent(token)}`);
}

function expectNoHorizontalOverflow(page: Page) {
  return expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    )
    .toBeLessThanOrEqual(0);
}

test.describe("sign up (AC1, AC2)", () => {
  test("member signs up, is told to check their email, and the verify link activates the account", async ({
    page,
  }) => {
    const email = uniqueEmail();
    await openSignUp(page);
    await emailField(page).fill(`  ${email.toUpperCase()} `);
    await passwordField(page).fill(PASSWORD);
    await signUpButton(page).click();

    await expect(page.getByText(/check your (email|inbox)/i).first()).toBeVisible();
    const signup = api.requests.find((r) => r.path === "/auth/signup");
    expect(signup).toBeTruthy();
    const token = api.lastEmail(email, "verify_email")?.token;
    expect(token, "verification email").toBeTruthy();

    await followEmailLink(page, "verify-email", token!);
    await expect(page.getByText(/verified|confirmed/i).first()).toBeVisible();
    expect(api.accounts.get(email)?.status).toBe("active");
    await expectNoHorizontalOverflow(page);
  });

  test("shows the password rule before submitting and blocks a too-short password", async ({
    page,
  }) => {
    await openSignUp(page);
    await emailField(page).fill(uniqueEmail());
    await passwordField(page).fill("short");
    await signUpButton(page).click();

    await expect(page.getByText(/at least 10 characters/i).first()).toBeVisible();
    expect(api.accounts.size).toBe(0);
  });

  test("shows an error for an invalid email", async ({ page }) => {
    await openSignUp(page);
    await emailField(page).fill("not-an-email");
    await passwordField(page).fill(PASSWORD);
    await signUpButton(page).click();

    await expect(page.getByText(/valid email/i).first()).toBeVisible();
    expect(api.accounts.size).toBe(0);
  });

  test("an existing email gets the same 'check your email' screen (no enumeration)", async ({
    page,
  }) => {
    const email = uniqueEmail();
    api.seed(email, PASSWORD);
    await openSignUp(page);
    await emailField(page).fill(email);
    await passwordField(page).fill("some other password");
    await signUpButton(page).click();

    await expect(page.getByText(/check your (email|inbox)/i).first()).toBeVisible();
    await expect(page.getByText(/already (exists|registered|in use)/i)).toHaveCount(0);
  });

  test("double-clicking sign up sends one request", async ({ page }) => {
    api.delayMs = 500;
    await openSignUp(page);
    await emailField(page).fill(uniqueEmail());
    await passwordField(page).fill(PASSWORD);
    await signUpButton(page).dblclick();
    await expect(page.getByText(/check your (email|inbox)/i).first()).toBeVisible();
    expect(api.requests.filter((r) => r.path === "/auth/signup")).toHaveLength(1);
  });

  test("a used or invalid verify link shows an error and a way to get a new link", async ({
    page,
  }) => {
    await followEmailLink(page, "verify-email", "v_not-a-real-token");
    await expect(page.getByText(/invalid|expired|no longer valid/i).first()).toBeVisible();
    await expect(
      page
        .getByRole("button", { name: /resend|send (a )?new/i })
        .or(page.getByRole("link", { name: /resend|send (a )?new|log ?in/i }))
        .first(),
    ).toBeVisible();
  });

  test("the verify token is not sent to the web host (stays in the fragment)", async ({ page }) => {
    const appRequests: string[] = [];
    page.on("request", (r) => appRequests.push(r.url()));
    await followEmailLink(page, "verify-email", "v_secret-token-value");
    await page.waitForLoadState("networkidle");
    for (const url of appRequests.filter((u) => !u.includes("/auth/"))) {
      expect(url).not.toContain("v_secret-token-value");
    }
  });
});

test.describe("log in and log out (AC3)", () => {
  test("member logs in, sees their account, and logs out", async ({ page }) => {
    const email = uniqueEmail();
    api.seed(email, PASSWORD);
    await logInVia(page, email);

    await expect(page.getByText(email).first()).toBeVisible();
    await logOutControl(page).click();
    await expect(page.getByRole("link", { name: /log ?in|sign ?in/i }).first()).toBeVisible();
    expect(api.requests.some((r) => r.path === "/auth/logout")).toBe(true);
    expect(api.activeSessions(email)).toHaveLength(0);
  });

  test("wrong password shows a generic error that doesn't say which field was wrong", async ({
    page,
  }) => {
    const email = uniqueEmail();
    api.seed(email, PASSWORD);
    await openLogIn(page);
    await emailField(page).fill(email);
    await passwordField(page).fill("wrong password!!");
    await logInButton(page).click();

    await expect(page.getByText(/incorrect|invalid|doesn't match|wrong/i).first()).toBeVisible();
    await expect(page.getByText(/no account|not registered|not found/i)).toHaveCount(0);
    await expect(logOutControl(page)).toHaveCount(0);
  });

  test("unknown email shows the same error as a wrong password", async ({ page }) => {
    const email = uniqueEmail();
    api.seed(email, PASSWORD);
    const errorFor = async (e: string) => {
      await openLogIn(page);
      await emailField(page).fill(e);
      await passwordField(page).fill("wrong password!!");
      await logInButton(page).click();
      const alert = page.getByRole("alert").first();
      await expect(alert).toBeVisible();
      return (await alert.textContent())?.trim();
    };
    expect(await errorFor(uniqueEmail())).toBe(await errorFor(email));
  });

  test("an unverified member can log in and is asked to verify their email", async ({ page }) => {
    const email = uniqueEmail();
    api.seed(email, PASSWORD, "pending_verification");
    await logInVia(page, email);
    await expect(
      page.getByText(/verify your email|confirm your email|check your (email|inbox)/i).first(),
    ).toBeVisible();
  });

  test("the session survives a reload", async ({ page }) => {
    const email = uniqueEmail();
    api.seed(email, PASSWORD);
    await logInVia(page, email);
    await page.reload();
    await expect(logOutControl(page)).toBeVisible();
    await expect(page.getByText(email).first()).toBeVisible();
  });

  test("the session survives closing and reopening the app (new tab, same storage)", async ({
    page,
    browser,
    baseURL,
  }) => {
    const email = uniqueEmail();
    api.seed(email, PASSWORD);
    await logInVia(page, email);
    const state = await page.context().storageState();
    await page.context().close();

    const context = await browser.newContext({ storageState: state });
    const reopened = await context.newPage();
    await api.install(reopened, new URL(baseURL!).origin);
    await reopened.goto("./");
    await expect(logOutControl(reopened)).toBeVisible();
    await context.close();
  });

  test("an expired access token is refreshed silently", async ({ page }) => {
    const email = uniqueEmail();
    api.seed(email, PASSWORD);
    await logInVia(page, email);
    api.expireAccessTokens();
    await page.reload();

    await expect(logOutControl(page)).toBeVisible();
    expect(api.requests.some((r) => r.path === "/auth/refresh")).toBe(true);
  });

  test("a revoked session sends the member back to log in", async ({ page }) => {
    const email = uniqueEmail();
    api.seed(email, PASSWORD);
    await logInVia(page, email);
    for (const s of api.sessions) s.revoked = true;
    api.expireAccessTokens();
    await page.reload();

    await expect(
      page
        .getByRole("link", { name: /log ?in|sign ?in/i })
        .or(logInButton(page))
        .first(),
    ).toBeVisible();
    await expect(logOutControl(page)).toHaveCount(0);
  });

  test("after logout, reloading does not restore the session", async ({ page }) => {
    const email = uniqueEmail();
    api.seed(email, PASSWORD);
    await logInVia(page, email);
    await logOutControl(page).click();
    await page.reload();
    await expect(logOutControl(page)).toHaveCount(0);
    const stored = await page.evaluate(
      () => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }),
    );
    expect(stored).not.toMatch(/plr_|pla_/);
  });

  test("API calls send the bearer token and no cookies", async ({ page }) => {
    const email = uniqueEmail();
    api.seed(email, PASSWORD);
    await logInVia(page, email);
    await page.reload();
    await expect(logOutControl(page)).toBeVisible();
    const me = api.requests.filter((r) => r.path === "/auth/me");
    expect(me.length).toBeGreaterThan(0);
    for (const r of me) expect(r.authorization).toMatch(/^Bearer pla_/);
  });

  test("double-clicking log in creates one session", async ({ page }) => {
    const email = uniqueEmail();
    api.seed(email, PASSWORD);
    api.delayMs = 500;
    await openLogIn(page);
    await emailField(page).fill(email);
    await passwordField(page).fill(PASSWORD);
    await logInButton(page).dblclick();
    await expect(logOutControl(page)).toBeVisible();
    expect(api.requests.filter((r) => r.path === "/auth/login")).toHaveLength(1);
  });

  test("shows a clear message when the API is unreachable", async ({ page }) => {
    const email = uniqueEmail();
    api.seed(email, PASSWORD);
    await openLogIn(page);
    api.offline = true;
    await emailField(page).fill(email);
    await passwordField(page).fill(PASSWORD);
    await logInButton(page).click();
    await expect(
      page.getByText(/try again|unreachable|connection|network|something went wrong/i).first(),
    ).toBeVisible();
  });
});

test.describe("password reset (AC4)", () => {
  test("member resets a forgotten password via the emailed link and logs in with it", async ({
    page,
  }) => {
    const email = uniqueEmail();
    api.seed(email, PASSWORD);
    await openLogIn(page);
    await page.getByRole("link", { name: /forgot/i }).click();
    await emailField(page).fill(email);
    await page.getByRole("button", { name: /send|reset/i }).click();
    await expect(page.getByText(/check your (email|inbox)/i).first()).toBeVisible();

    const token = api.lastEmail(email, "password_reset")?.token;
    expect(token, "reset email").toBeTruthy();
    await followEmailLink(page, "reset-password", token!);
    await passwordField(page).fill(NEW_PASSWORD);
    const confirmField = page.getByLabel(/confirm|repeat/i);
    if (await confirmField.count()) await confirmField.first().fill(NEW_PASSWORD);
    await page.getByRole("button", { name: /reset|save|change|set/i }).click();
    await expect(
      page.getByText(/password (has been )?(changed|reset|updated)/i).first(),
    ).toBeVisible();

    await logInVia(page, email, NEW_PASSWORD);
    await expectNoHorizontalOverflow(page);
  });

  test("forgot password for an unknown email shows the same confirmation", async ({ page }) => {
    await openLogIn(page);
    await page.getByRole("link", { name: /forgot/i }).click();
    await emailField(page).fill(uniqueEmail());
    await page.getByRole("button", { name: /send|reset/i }).click();
    await expect(page.getByText(/check your (email|inbox)/i).first()).toBeVisible();
    expect(api.emails).toHaveLength(0);
  });

  test("a used reset link shows an error", async ({ page }) => {
    await followEmailLink(page, "reset-password", "r_not-a-real-token");
    await passwordField(page).fill(NEW_PASSWORD);
    const confirmField = page.getByLabel(/confirm|repeat/i);
    if (await confirmField.count()) await confirmField.first().fill(NEW_PASSWORD);
    await page.getByRole("button", { name: /reset|save|change|set/i }).click();
    await expect(page.getByText(/invalid|expired|no longer valid/i).first()).toBeVisible();
  });

  test("reset enforces the password rule", async ({ page }) => {
    const email = uniqueEmail();
    api.seed(email, PASSWORD);
    await openLogIn(page);
    await page.getByRole("link", { name: /forgot/i }).click();
    await emailField(page).fill(email);
    await page.getByRole("button", { name: /send|reset/i }).click();
    await expect(page.getByText(/check your (email|inbox)/i).first()).toBeVisible();
    const token = api.lastEmail(email, "password_reset")!.token!;

    await followEmailLink(page, "reset-password", token);
    await passwordField(page).fill("short");
    const confirmField = page.getByLabel(/confirm|repeat/i);
    if (await confirmField.count()) await confirmField.first().fill("short");
    await page.getByRole("button", { name: /reset|save|change|set/i }).click();
    await expect(page.getByText(/at least 10 characters/i).first()).toBeVisible();
    expect(api.accounts.get(email)?.password).toBe(PASSWORD);
  });
});

test.describe("copy and layout", () => {
  test("auth pages fit the viewport and don't hard-code the points name", async ({ page }) => {
    for (const open of [openSignUp, openLogIn]) {
      await open(page);
      await expectNoHorizontalOverflow(page);
      const text = (await page.locator("body").innerText()).toLowerCase();
      expect(text).not.toContain("almas");
      if (/points/.test(text)) expect(text).toContain(POINTS_NAME.toLowerCase());
    }
  });
});
