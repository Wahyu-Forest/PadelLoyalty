/**
 * QA (issue #3): under-18 sign-up, the pending-consent screen and the guardian
 * consent page, against the in-browser fake API (e2e/support/qa-fake-auth-api.ts),
 * which follows docs/api/consent.md.
 *
 * Runs in both Playwright projects (desktop and Pixel 7) and under the GitHub
 * Pages base path. The guardian link path is part of the contract:
 * `{APP_URL}/guardian-consent/#token=…`. Locators use accessible names loose
 * enough not to depend on exact copy.
 */
import { expect, test, type Page } from "@playwright/test";
import { FakeAuthApi } from "./support/qa-fake-auth-api";

const PASSWORD = "correct horse battery";

let api: FakeAuthApi;

test.beforeEach(async ({ page, baseURL }) => {
  api = new FakeAuthApi();
  await api.install(page, new URL(baseURL!).origin);
});

const uniqueEmail = (tag = "qa") =>
  `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;

/** `YYYY-MM-DD`, `years` years before today (UTC), plus `days`. */
function dobYearsAgo(years: number, days = 0): string {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear() - years, now.getUTCMonth(), now.getUTCDate() + days),
  )
    .toISOString()
    .slice(0, 10);
}

const emailField = (page: Page) => page.getByLabel(/^email/i).first();
const passwordField = (page: Page) => page.getByLabel(/^(new )?password$/i).first();
const dateOfBirthField = (page: Page) => page.getByLabel(/date of birth|birthday/i).first();
const guardianField = (page: Page) => page.getByLabel(/(parent|guardian).*email/i).first();
const signUpButton = (page: Page) =>
  page.getByRole("button", { name: /sign up|create (an )?account|register/i });
const logInButton = (page: Page) => page.getByRole("button", { name: /log ?in|sign ?in/i });
const logOutControl = (page: Page) => page.getByRole("button", { name: /log ?out|sign ?out/i });
const attestation = (page: Page) =>
  page.getByRole("checkbox", { name: /parent|guardian/i }).first();
const confirmButton = (page: Page) =>
  page.getByRole("button", { name: /confirm|give consent|i consent|approve|agree/i }).first();
const declineButton = (page: Page) =>
  page.getByRole("button", { name: /decline|refuse|don.t (consent|agree)/i }).first();
const resendButton = (page: Page) =>
  page.getByRole("button", { name: /resend|send (it )?again|send (a )?new/i }).first();

async function waitForHydratedForm(page: Page) {
  await page.waitForFunction(() => {
    const form = document.querySelector("form");
    return !!form && Object.keys(form).some((k) => k.startsWith("__reactProps"));
  });
}

async function openSignUp(page: Page) {
  await page.goto("./");
  await page
    .getByRole("link", { name: /sign up|create (an )?account|register|join/i })
    .first()
    .click();
  await expect(signUpButton(page)).toBeVisible();
  await waitForHydratedForm(page);
}

async function logInVia(page: Page, email: string, password = PASSWORD) {
  await page.goto("./");
  await page
    .getByRole("link", { name: /log ?in|sign ?in/i })
    .first()
    .click();
  await expect(logInButton(page)).toBeVisible();
  await waitForHydratedForm(page);
  await emailField(page).fill(email);
  await passwordField(page).fill(password);
  await logInButton(page).click();
  await expect(logOutControl(page)).toBeVisible();
}

async function openGuardianLink(page: Page, token: string) {
  await page.goto(`guardian-consent/#token=${encodeURIComponent(token)}`);
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

function signUpRequests() {
  return api.requests.filter((r) => r.path === "/auth/signup");
}

test.describe("AC1: date of birth at sign-up", () => {
  test("an adult signs up with a date of birth and is not asked for a guardian", async ({
    page,
  }) => {
    const email = uniqueEmail();
    await openSignUp(page);
    await emailField(page).fill(email);
    await passwordField(page).fill(PASSWORD);
    await dateOfBirthField(page).fill(dobYearsAgo(30));
    await expect(guardianField(page)).toBeHidden();
    await signUpButton(page).click();

    await expect(page.getByText(/check your (email|inbox)/i).first()).toBeVisible();
    const body = signUpRequests()[0]?.body as Record<string, unknown>;
    expect(body).toMatchObject({ email, dateOfBirth: dobYearsAgo(30) });
    expect(body.guardianEmail).toBeUndefined();
  });

  test("the date of birth is required", async ({ page }) => {
    await openSignUp(page);
    await emailField(page).fill(uniqueEmail());
    await passwordField(page).fill(PASSWORD);
    await signUpButton(page).click();
    await expect(
      page.getByText(/enter your date of birth|date of birth is required|required/i).first(),
    ).toBeVisible();
    expect(api.accounts.size).toBe(0);
  });

  test("a date of birth in the future is rejected before sending", async ({ page }) => {
    await openSignUp(page);
    await emailField(page).fill(uniqueEmail());
    await passwordField(page).fill(PASSWORD);
    await dateOfBirthField(page).fill(dobYearsAgo(-1));
    await signUpButton(page).click();
    await expect(page.getByText(/future|real date|check/i).first()).toBeVisible();
    expect(api.accounts.size).toBe(0);
  });
});

test.describe("AC2: under-18 sign-up needs a guardian email", () => {
  test("an under-18 must give a guardian email, which must differ from theirs", async ({
    page,
  }) => {
    const email = uniqueEmail("junior");
    const guardian = uniqueEmail("guardian");
    await openSignUp(page);
    await emailField(page).fill(email);
    await passwordField(page).fill(PASSWORD);
    await dateOfBirthField(page).fill(dobYearsAgo(15));
    await expect(guardianField(page)).toBeVisible();

    // Missing guardian email.
    await signUpButton(page).click();
    await expect(page.getByText(/under 18|parent|guardian/i).first()).toBeVisible();
    expect(api.accounts.size).toBe(0);

    // Same as the member's, differing only in case and spaces.
    await guardianField(page).fill(`  ${email.toUpperCase()} `);
    await signUpButton(page).click();
    await expect(page.getByText(/different/i).first()).toBeVisible();
    expect(api.accounts.size).toBe(0);

    await guardianField(page).fill(guardian);
    await signUpButton(page).click();
    await expect(page.getByText(/check your (email|inbox)/i).first()).toBeVisible();
    expect(signUpRequests()[0]?.body).toMatchObject({
      email,
      dateOfBirth: dobYearsAgo(15),
      guardianEmail: guardian,
    });
    // Nothing goes to the guardian until the member verifies their own email.
    expect(api.lastEmail(guardian)).toBeUndefined();
  });

  test("18 today is an adult; 18 tomorrow needs a guardian", async ({ page }) => {
    await openSignUp(page);
    await dateOfBirthField(page).fill(dobYearsAgo(18));
    await expect(guardianField(page)).toBeHidden();
    await dateOfBirthField(page).fill(dobYearsAgo(18, 1));
    await expect(guardianField(page)).toBeVisible();
  });

  test("after verifying, an under-18 is told consent is pending and the guardian is emailed", async ({
    page,
  }) => {
    const email = uniqueEmail("junior");
    const guardian = uniqueEmail("guardian");
    await openSignUp(page);
    await emailField(page).fill(email);
    await passwordField(page).fill(PASSWORD);
    await dateOfBirthField(page).fill(dobYearsAgo(15));
    await guardianField(page).fill(guardian);
    await signUpButton(page).click();
    await expect(page.getByText(/check your (email|inbox)/i).first()).toBeVisible();

    const verifyToken = api.lastEmail(email, "verify_email")!.token!;
    await page.goto(`verify-email/#token=${encodeURIComponent(verifyToken)}`);
    await expect(page.getByText(/parent|guardian/i).first()).toBeVisible();
    expect(api.accounts.get(email)?.status).toBe("pending_consent");
    expect(api.lastEmail(guardian, "guardian_consent")?.token).toMatch(/^plc_/);
  });
});

test.describe("AC3: pending account screen", () => {
  test("a pending member sees why, the guardian email, and can resend", async ({ page }) => {
    const email = uniqueEmail("junior");
    const guardian = uniqueEmail("guardian");
    const { token: first } = api.seedPendingMinor(email, PASSWORD, guardian, dobYearsAgo(14));
    await logInVia(page, email);

    await expect(
      page.getByText(/(waiting|pending).*(consent|guardian|parent)|consent/i).first(),
    ).toBeVisible();
    await expect(page.getByText(guardian).first()).toBeVisible();

    await resendButton(page).click();
    await expect(page.getByText(/sent|resent/i).first()).toBeVisible();
    const requests = api.requests.filter((r) => r.path === "/auth/consent/request");
    expect(requests).toHaveLength(1);
    expect(requests[0]!.authorization).toMatch(/^Bearer pla_/);
    const second = api.lastEmail(guardian, "guardian_consent")!.token!;
    expect(second).not.toBe(first);
    await expectNoHorizontalOverflow(page);
  });

  test("double-clicking resend sends one request", async ({ page }) => {
    const email = uniqueEmail("junior");
    api.seedPendingMinor(email, PASSWORD, uniqueEmail("guardian"), dobYearsAgo(14));
    await logInVia(page, email);
    api.delayMs = 500;
    await resendButton(page).dblclick();
    await expect(page.getByText(/sent|resent/i).first()).toBeVisible();
    expect(api.requests.filter((r) => r.path === "/auth/consent/request")).toHaveLength(1);
  });

  test("after a decline the member sees it and can nominate a different guardian", async ({
    page,
  }) => {
    const email = uniqueEmail("junior");
    const guardian = uniqueEmail("guardian");
    const other = uniqueEmail("guardian2");
    const { token } = api.seedPendingMinor(email, PASSWORD, guardian, dobYearsAgo(14));
    api.consentRequests.find((r) => r.token === token)!.status = "declined";
    await logInVia(page, email);
    await expect(page.getByText(/declined/i).first()).toBeVisible();

    await guardianField(page).fill(other);
    await page
      .getByRole("button", { name: /send|change|update|ask/i })
      .first()
      .click();
    await expect(page.getByText(other).first()).toBeVisible();
    expect(api.lastEmail(other, "guardian_consent")).toBeTruthy();
  });

  test("an adult member sees no consent message", async ({ page }) => {
    const email = uniqueEmail("adult");
    api.seed(email, PASSWORD, "active", "member", { dateOfBirth: dobYearsAgo(30) });
    await logInVia(page, email);
    await expect(page.getByText(/guardian|parental consent/i)).toHaveCount(0);
  });
});

test.describe("AC2: guardian consent page (from the emailed link)", () => {
  test("the guardian reviews and confirms; the member becomes active", async ({ page }) => {
    const email = uniqueEmail("junior");
    const guardian = uniqueEmail("guardian");
    const dob = dobYearsAgo(13);
    const { token } = api.seedPendingMinor(email, PASSWORD, guardian, dob);

    await openGuardianLink(page, token);
    await expect(page.getByText(email).first()).toBeVisible();
    await expect(page.getByText(/placeholder|safeguarding/i).first()).toBeVisible();

    // Confirming needs the "I am the parent or legal guardian" statement.
    await expect(attestation(page)).toBeVisible();
    await confirmButton(page).click();
    expect(
      api.requests.filter(
        (r) =>
          r.path === "/auth/consent/decision" &&
          (r.body as { decision?: string }).decision === "confirm" &&
          (r.body as { isParentOrGuardian?: unknown }).isParentOrGuardian !== true,
      ),
    ).toHaveLength(0);
    await attestation(page).check();
    await confirmButton(page).click();

    await expect(
      page.getByText(/thank|confirmed|consent (has been )?(given|recorded)/i).first(),
    ).toBeVisible();
    expect(api.accounts.get(email)?.status).toBe("active");
    // The token is removed from the address bar after use, and never sent to the web host.
    await expect.poll(() => page.url()).not.toContain(token);
    // The guardian page sends no bearer token (works without logging in).
    for (const r of api.requests.filter((x) => x.path.startsWith("/auth/consent/")))
      expect(r.authorization).toBeUndefined();
    await expectNoHorizontalOverflow(page);
  });

  test("the guardian declines; the member stays pending", async ({ page }) => {
    const email = uniqueEmail("junior");
    const { token } = api.seedPendingMinor(email, PASSWORD, uniqueEmail("g"), dobYearsAgo(13));
    await openGuardianLink(page, token);
    await expect(page.getByText(email).first()).toBeVisible();
    await declineButton(page).click();
    await expect(page.getByText(/declined|won.t|not given/i).first()).toBeVisible();
    expect(api.accounts.get(email)?.status).toBe("pending_consent");
    expect(api.consentRequests.at(-1)?.status).toBe("declined");
  });

  test("reopening a used link shows it is no longer valid", async ({ page }) => {
    const email = uniqueEmail("junior");
    const { token } = api.seedPendingMinor(email, PASSWORD, uniqueEmail("g"), dobYearsAgo(13));
    await openGuardianLink(page, token);
    await attestation(page).check();
    await confirmButton(page).click();
    await expect(page.getByText(/thank|confirmed/i).first()).toBeVisible();

    await openGuardianLink(page, token);
    await expect(page.getByText(/invalid|expired|no longer valid|already/i).first()).toBeVisible();
    await expect(confirmButton(page)).toHaveCount(0);
  });

  test("an expired, replaced or made-up link shows an error and no decision buttons", async ({
    page,
  }) => {
    const email = uniqueEmail("junior");
    const { token } = api.seedPendingMinor(email, PASSWORD, uniqueEmail("g"), dobYearsAgo(13));
    api.expireConsentLinks();
    for (const t of [token, "plc_made-up-token"]) {
      await openGuardianLink(page, t);
      await expect(page.getByText(/invalid|expired|no longer valid/i).first()).toBeVisible();
      await expect(confirmButton(page)).toHaveCount(0);
      await expect(declineButton(page)).toHaveCount(0);
    }
  });

  test("a link without a token shows an error", async ({ page }) => {
    await page.goto("guardian-consent/");
    await expect(page.getByText(/invalid|missing|expired|no longer valid/i).first()).toBeVisible();
  });

  test("double-clicking confirm sends one decision", async ({ page }) => {
    const email = uniqueEmail("junior");
    const { token } = api.seedPendingMinor(email, PASSWORD, uniqueEmail("g"), dobYearsAgo(13));
    await openGuardianLink(page, token);
    await attestation(page).check();
    api.delayMs = 500;
    await confirmButton(page).dblclick();
    await expect(page.getByText(/thank|confirmed/i).first()).toBeVisible();
    expect(api.requests.filter((r) => r.path === "/auth/consent/decision")).toHaveLength(1);
  });
});
