import { POINTS_NAME } from "@padelloyalty/shared";
import { expect, test, type Page } from "@playwright/test";
import { resolveBasePath } from "../src/lib/base-path";
import { FakeAuthApi } from "./support/fake-auth-api";

// #3 Under-18 guardian consent. Runs on desktop and phone viewports, at the
// root and under the GitHub Pages base path. The API is the contract-checked fake.
const basePath = resolveBasePath(process.env.NEXT_PUBLIC_BASE_PATH);
const KID = "kid@example.com";
const MUM = "mum@example.com";
const DAD = "dad@example.com";
const PASSWORD = "correct horse battery";
const KID_DOB = `${new Date().getFullYear() - 14}-06-15`;

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

const emailField = (page: Page) => page.getByLabel("Email", { exact: true });
const guardianField = (page: Page) => page.getByLabel("Parent or guardian's email");

async function logIn(page: Page, email = KID) {
  await page.goto("login/");
  await emailField(page).fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByTestId("account-email")).toHaveText(email);
}

/** An under-18 member whose email is verified and whose guardian has been emailed. */
function pendingMinor(guardian = MUM) {
  return api.addPendingMinor(KID, PASSWORD, KID_DOB, guardian);
}

test("an under-18 signs up, verifies, waits for consent; the guardian confirms; the account is active", async ({
  page,
}) => {
  await page.goto("signup/");
  await expect(guardianField(page)).toHaveCount(0);
  await emailField(page).fill(KID);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByLabel("Date of birth").fill(KID_DOB);
  await expect(guardianField(page)).toBeVisible();
  await guardianField(page).fill(" Mum@Example.com ");
  await page.getByRole("button", { name: "Sign up" }).click();

  await expect(page.getByTestId("signup-done")).toContainText(KID);
  await expect(page.getByTestId("signup-guardian-next")).toContainText(MUM);
  // Nothing goes to the guardian before the member verifies.
  expect(api.emails.filter((e) => e.type === "guardian_consent")).toHaveLength(0);

  await page.goto(api.linkPath(KID, "verify_email"));
  await expect(page.getByTestId("verify-success")).toContainText(/guardian/i);
  await expect(page.getByTestId("verify-success")).not.toContainText(/account is active/i);
  await expect(page.getByTestId("verify-pending-consent")).toBeVisible();
  expect(api.emails.filter((e) => e.type === "guardian_consent").map((e) => e.to)).toEqual([MUM]);

  await logIn(page);
  const panel = page.getByTestId("consent-pending");
  await expect(panel).toContainText("Waiting for your parent or guardian");
  await expect(panel).toContainText(POINTS_NAME);
  await expect(page.getByTestId("consent-state")).toHaveAttribute("data-state", "pending");
  await expect(page.getByTestId("consent-state")).toContainText(MUM);

  // The guardian opens their link (here in the same browser).
  await page.goto(api.linkPath(MUM, "guardian_consent"));
  await expect.poll(() => new URL(page.url()).pathname).toBe(`${basePath}/guardian-consent/`);
  const details = page.getByTestId("consent-details");
  await expect(details).toContainText(KID);
  await expect(details).toContainText(MUM);
  await expect(details).toContainText("age 14");
  await expect(page.getByTestId("safeguarding-placeholder")).toContainText("PLACEHOLDER");
  await expect(page.getByTestId("guardian-consent")).toContainText(POINTS_NAME);

  await page.getByRole("button", { name: "Give consent" }).click();
  await expect(page.getByText("Confirm that you are this member's parent")).toBeVisible();
  expect(api.calls).not.toContain("POST /auth/consent/decision");

  await page.getByLabel("I am this member's parent or legal guardian").check();
  await page.getByRole("button", { name: "Give consent" }).click();
  await expect(page.getByTestId("consent-done")).toContainText(/account is now active/i);
  await expect.poll(() => new URL(page.url()).hash).toBe("");

  await page.goto("./");
  await expect(page.getByTestId("account-email")).toHaveText(KID);
  await expect(page.getByTestId("consent-pending")).toHaveCount(0);
  // Active now: the home shows the points balance (#6).
  await expect(page.getByTestId("points-balance")).toContainText(`Your ${POINTS_NAME}`);
  await expect(page.getByTestId("points-balance-value")).toHaveText("0");
});

test("asks for a guardian only under 18, and not the member's own email", async ({ page }) => {
  await page.goto("signup/");
  await emailField(page).fill(KID);
  await page.getByLabel("Password").fill(PASSWORD);

  await page.getByLabel("Date of birth").fill("1990-04-15");
  await expect(guardianField(page)).toHaveCount(0);

  await page.getByLabel("Date of birth").fill(KID_DOB);
  await guardianField(page).fill(KID.toUpperCase());
  await page.getByRole("button", { name: "Sign up" }).click();
  await expect(page.getByText("must be different from yours")).toBeVisible();

  await guardianField(page).fill("");
  await page.getByRole("button", { name: "Sign up" }).click();
  await expect(page.getByText("Members under 18 need a parent or guardian's email")).toBeVisible();
  expect(api.calls).not.toContain("POST /auth/signup");
});

test("rejects a future date of birth before sending", async ({ page }) => {
  await page.goto("signup/");
  await emailField(page).fill(KID);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByLabel("Date of birth").fill(`${new Date().getFullYear() + 1}-01-01`);
  await page.getByRole("button", { name: "Sign up" }).click();
  await expect(page.getByText("can't be in the future")).toBeVisible();
  expect(api.calls).not.toContain("POST /auth/signup");
});

test("the member can resend the request; the old link stops working", async ({ page }) => {
  pendingMinor();
  const firstLink = api.linkPath(MUM, "guardian_consent");
  await logIn(page);
  await page.getByRole("button", { name: "Resend request" }).click();
  await expect(page.getByTestId("consent-message")).toContainText(`emailed ${MUM}`);
  expect(api.calls).toContain("POST /auth/consent/request");

  await page.goto(firstLink);
  await expect(page.getByTestId("form-error")).toContainText(/invalid|expired|used/i);
  await page.goto(api.linkPath(MUM, "guardian_consent"));
  await expect(page.getByTestId("consent-details")).toContainText(KID);
});

test("after a decline the member is told and can ask a different guardian, not the same one", async ({
  page,
}) => {
  pendingMinor();
  await page.goto(api.linkPath(MUM, "guardian_consent"));
  await page.getByRole("button", { name: "Decline" }).click();
  await expect(page.getByTestId("consent-done")).toContainText(/declined/i);

  await logIn(page);
  await expect(page.getByTestId("consent-state")).toHaveAttribute("data-state", "declined");
  await expect(page.getByTestId("consent-state")).toContainText(MUM);
  await expect(page.getByRole("button", { name: "Resend request" })).toHaveCount(0);

  await guardianField(page).fill(MUM);
  await page.getByRole("button", { name: "Send request", exact: true }).click();
  await expect(page.getByTestId("form-error")).toContainText(/already declined/i);

  await guardianField(page).fill(DAD);
  await page.getByRole("button", { name: "Send request", exact: true }).click();
  await expect(page.getByTestId("consent-message")).toContainText(`emailed ${DAD}`);
  await expect(page.getByTestId("consent-state")).toHaveAttribute("data-state", "pending");
  await expect(page.getByTestId("consent-state")).toContainText(DAD);
});

test("the member can switch to a different guardian while the request is pending", async ({
  page,
}) => {
  pendingMinor();
  await logIn(page);
  await page.getByRole("button", { name: "Use a different email" }).click();
  await guardianField(page).fill(KID);
  await page.getByRole("button", { name: "Send request", exact: true }).click();
  await expect(page.getByText("must be different from yours")).toBeVisible();

  await guardianField(page).fill(DAD);
  await page.getByRole("button", { name: "Send request", exact: true }).click();
  await expect(page.getByTestId("consent-state")).toContainText(DAD);
  expect(api.emails.at(-1)).toMatchObject({ to: DAD, type: "guardian_consent" });
});

test("an invalid or incomplete consent link explains what to do", async ({ page }) => {
  await page.goto("guardian-consent/#token=plc_not-real");
  await expect(page.getByTestId("form-error")).toContainText(/invalid|expired|used/i);
  await page.goto("guardian-consent/");
  await expect(page.getByTestId("form-error")).toContainText(/incomplete/i);
});
