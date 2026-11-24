import type { UserRole } from "@padelloyalty/shared";
import { expect, test, type Page } from "@playwright/test";
import { resolveBasePath } from "../src/lib/base-path";
import { FakeAuthApi } from "./support/fake-auth-api";
import { FakeClubsApi } from "./support/fake-clubs-api";

// #56 Club and court setup in the staff back office. Runs on desktop and phone
// viewports, at the root and under the GitHub Pages base path. The API is a
// contract-checked fake; the real role guards are tested in apps/api.
const basePath = resolveBasePath(process.env.NEXT_PUBLIC_BASE_PATH);
const PASSWORD = "correct horse battery";

let auth: FakeAuthApi;
let clubs: FakeClubsApi;

test.beforeEach(async ({ page }) => {
  auth = new FakeAuthApi();
  await auth.install(page);
  clubs = new FakeClubsApi(auth);
  await clubs.install(page);
  await page.route("**/health", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({ status: "ok", database: "up", timestamp: new Date().toISOString() }),
    }),
  );
});

function addUser(email: string, role: UserRole) {
  const account = auth.addAccount(email, PASSWORD);
  account.user = { ...account.user, role };
}

async function logIn(page: Page, email: string) {
  await page.goto("login/");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect.poll(() => new URL(page.url()).pathname).not.toBe(`${basePath}/login/`);
}

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, `horizontal overflow on ${page.url()}`).toBeLessThanOrEqual(0);
}

test.describe("access", () => {
  test("logged-out visitors are asked to log in and come back to the back office", async ({
    page,
  }) => {
    addUser("boss@example.com", "admin");
    await page.goto("admin/clubs/");
    await expect(page.getByTestId("gate-login")).toBeVisible();
    await expect(page.getByTestId("club-list")).toHaveCount(0);
    await page.getByTestId("gate-login").getByRole("link", { name: "Log in" }).click();
    await expect.poll(() => new URL(page.url()).pathname).toBe(`${basePath}/login/`);

    await page.getByLabel("Email").fill("boss@example.com");
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Log in" }).click();
    await expect.poll(() => new URL(page.url()).pathname).toBe(`${basePath}/admin/clubs/`);
    await expect(page.getByTestId("no-clubs")).toBeVisible();
  });

  test("members get a clear no-access message and no admin calls are made", async ({ page }) => {
    addUser("member@example.com", "member");
    await logIn(page, "member@example.com");
    for (const path of ["admin/", "admin/clubs/", "admin/clubs/new/"]) {
      await page.goto(path);
      await expect(page.getByTestId("no-access")).toContainText("No access");
      await expect(page.getByTestId("no-access")).toContainText("for Soul Padel staff only");
    }
    await expect(page.getByRole("button", { name: "Create club" })).toHaveCount(0);
    expect(clubs.calls).toEqual([]);
  });

  test("receptionists see the back office but not club setup", async ({ page }) => {
    addUser("desk@example.com", "receptionist");
    await logIn(page, "desk@example.com");
    await page.goto("admin/");
    await expect(page.getByTestId("admin-home")).toBeVisible();
    await expect(page.getByRole("link", { name: "Clubs and courts" })).toHaveCount(0);
    await page.goto("admin/clubs/");
    await expect(page.getByTestId("no-access")).toContainText("Club setup is for admins only");
  });

  test("admins see club setup on the back office home", async ({ page }) => {
    addUser("boss@example.com", "admin");
    await logIn(page, "boss@example.com");
    await page.goto("admin/");
    await expect(page.getByTestId("admin-bar")).toContainText("boss@example.com (admin)");
    await page.getByRole("link", { name: "Clubs and courts" }).click();
    await expect.poll(() => new URL(page.url()).pathname).toBe(`${basePath}/admin/clubs/`);
  });
});

test("an admin sets up a club: details, hours, courts, prices and blocks", async ({ page }) => {
  addUser("boss@example.com", "admin");
  await logIn(page, "boss@example.com");

  // Create the club.
  await page.goto("admin/clubs/");
  await page.getByRole("link", { name: "New club" }).click();
  await page.getByLabel("Club name").fill("Soul Padel Battersea");
  await page.getByLabel("Address").fill("1 Riverside, London SW11");
  await expect(page.getByLabel("Time zone")).toHaveValue("Europe/London");
  await expect(page.getByLabel("Currency")).toHaveValue("GBP");
  await page.getByLabel("Open on Sunday").uncheck();
  await page.getByLabel("Saturday closes").selectOption("24:00");
  await page.getByRole("button", { name: "Create club" }).click();
  await expect(page.getByTestId("club-title")).toHaveText("Soul Padel Battersea");
  expect(new URL(page.url()).pathname).toBe(`${basePath}/admin/club/`);
  const stored = [...clubs.clubs.values()][0]!;
  expect(stored.club.openingHours.sun).toBeNull();
  expect(stored.club.openingHours.sat).toEqual({ opens: "08:00", closes: "24:00" });
  await expectNoHorizontalScroll(page);

  // Courts.
  await page.getByRole("tab", { name: "Courts" }).click();
  await expect(page.getByTestId("no-courts")).toBeVisible();
  await page.getByLabel("Court name").fill("Court 1");
  await page.getByRole("button", { name: "Add court" }).click();
  await expect(page.getByTestId("court-row")).toHaveCount(1);
  await page.getByLabel("Court name").fill("Court 2");
  await page.getByLabel("Indoor or outdoor").selectOption("outdoor");
  await page.getByRole("button", { name: "Add court" }).click();
  await expect(page.getByTestId("court-row")).toHaveCount(2);
  await page.getByLabel("Court name").fill("court 1");
  await page.getByRole("button", { name: "Add court" }).click();
  await expect(page.getByTestId("form-error")).toContainText("already has a court with this name");

  const court2 = page.locator('[data-court="Court 2"]');
  await court2.getByRole("button", { name: "Deactivate" }).click();
  await expect(page.locator('[data-court="Court 2"]').getByTestId("court-status")).toHaveText(
    "Inactive",
  );
  await page.locator('[data-court="Court 2"]').getByRole("button", { name: "Reactivate" }).click();
  await expect(page.locator('[data-court="Court 2"]').getByTestId("court-status")).toHaveText(
    "Active",
  );
  await expectNoHorizontalScroll(page);

  // Prices.
  await page.getByRole("tab", { name: "Prices" }).click();
  await expect(page.getByTestId("no-pricing")).toBeVisible();
  await page.getByLabel("Standard price for 60 min").fill("30");
  await page.getByLabel("Standard price for 90 min").fill("42.50");
  await page.getByRole("button", { name: "Add peak band" }).click();
  await page.getByLabel("Band 1 price for 60 min").fill("40");
  await page.getByLabel("Band 1 price for 90 min").fill("56");
  // A second band with the same default times overlaps the first.
  await page.getByRole("button", { name: "Add peak band" }).click();
  await page.getByLabel("Band 2 name").fill("Evening");
  await page.getByLabel("Band 2 price for 60 min").fill("45");
  await page.getByLabel("Band 2 price for 90 min").fill("60");
  await page.getByRole("button", { name: "Save prices" }).click();
  await expect(page.getByTestId("pricing-errors")).toContainText('overlaps band "Peak"');
  expect(clubs.calls.filter((c) => c.startsWith("PUT"))).toEqual([]);
  await page.getByTestId("price-band").nth(1).getByRole("button", { name: "Remove band" }).click();
  await page.getByLabel("Standard price for 60 min").fill("30.555");
  await page.getByRole("button", { name: "Save prices" }).click();
  await expect(page.getByTestId("pricing-errors")).toContainText("is not a price");
  await page.getByLabel("Standard price for 60 min").fill("30");
  await page.getByRole("button", { name: "Save prices" }).click();
  await expect(page.getByTestId("pricing-saved")).toBeVisible();
  expect(stored.pricing).toEqual({
    slotLengthsMinutes: [60, 90],
    standardPrices: [
      { minutes: 60, amountMinor: 3000 },
      { minutes: 90, amountMinor: 4250 },
    ],
    bands: [
      {
        label: "Peak",
        days: ["mon", "tue", "wed", "thu", "fri"],
        starts: "17:00",
        ends: "22:00",
        prices: [
          { minutes: 60, amountMinor: 4000 },
          { minutes: 90, amountMinor: 5600 },
        ],
      },
    ],
  });
  await expect(page.getByTestId("pricing-summary")).toContainText("£42.50");
  await expect(page.getByTestId("pricing-summary")).toContainText("£56.00");
  await expectNoHorizontalScroll(page);

  // Blocks.
  await page.getByRole("tab", { name: "Blocks" }).click();
  await expect(page.getByTestId("no-blocks")).toBeVisible();
  await page.getByRole("checkbox", { name: "Court 1" }).check();
  await page.getByLabel("From").fill("2026-12-01T10:00");
  await page.getByLabel("Until").fill("2026-12-01T09:00");
  await page.getByRole("button", { name: "Block courts" }).click();
  await expect(page.getByText("The block must end after it starts")).toBeVisible();
  await page.getByLabel("Until").fill("2026-12-01T12:30");
  await page.getByLabel("Reason").selectOption("event");
  await page.getByLabel("Note (optional)").fill("Junior tournament");
  await page.getByRole("button", { name: "Block courts" }).click();
  await expect(page.getByTestId("block-created")).toHaveText("Court blocked.");
  const row = page.getByTestId("block-row");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("Court 1");
  await expect(row).toContainText("Tue 1 Dec 2026, 10:00");
  await expect(row).toContainText("Tue 1 Dec 2026, 12:30");
  await expect(row).toContainText("Junior tournament");
  expect(stored.blocks[0]).toMatchObject({
    startsAt: "2026-12-01T10:00:00.000Z",
    endsAt: "2026-12-01T12:30:00.000Z",
  });
  await expectNoHorizontalScroll(page);
  await row.getByRole("button", { name: /Remove block on Court 1/ }).click();
  await expect(page.getByTestId("no-blocks")).toBeVisible();

  // Details: the currency is locked while prices exist; edits save.
  await page.getByRole("tab", { name: "Details & hours" }).click();
  await expect(page.getByLabel("Currency")).toBeDisabled();
  await page.getByLabel("Club name").fill("Soul Padel Clapham");
  await page.getByRole("button", { name: "Save details" }).click();
  await expect(page.getByTestId("club-saved")).toBeVisible();
  await expect(page.getByTestId("club-title")).toHaveText("Soul Padel Clapham");

  // Back to the list.
  await page.getByRole("link", { name: "All clubs" }).click();
  const listed = page.getByTestId("club-row");
  await expect(listed).toHaveCount(1);
  await expect(listed).toContainText("Soul Padel Clapham");
  await expect(listed).toContainText("2 active");
  await expect(listed).toContainText("Set (GBP)");
  await expectNoHorizontalScroll(page);
});

test("club form shows validation errors before calling the API", async ({ page }) => {
  addUser("boss@example.com", "admin");
  await logIn(page, "boss@example.com");
  await page.goto("admin/clubs/new/");
  await page.getByLabel("Time zone").fill("BST");
  await page.getByLabel("Monday opens").selectOption("23:00");
  await page.getByLabel("Monday closes").selectOption("09:00");
  await page.getByRole("button", { name: "Create club" }).click();
  await expect(page.getByText("Enter the club name")).toBeVisible();
  await expect(page.getByText("Choose an IANA time zone")).toBeVisible();
  await expect(page.getByText("Monday: closing time must be after opening time")).toBeVisible();
  expect(clubs.calls).toEqual([]);
});

test("a duplicate club name is reported", async ({ page }) => {
  addUser("boss@example.com", "admin");
  clubs.addClub({ name: "Soul Padel Battersea" });
  await logIn(page, "boss@example.com");
  await page.goto("admin/clubs/new/");
  await page.getByLabel("Club name").fill("soul padel battersea");
  await page.getByLabel("Address").fill("Somewhere");
  await page.getByRole("button", { name: "Create club" }).click();
  await expect(page.getByTestId("form-error")).toContainText("Another club already has this name");
});

test("an unknown club id shows a message", async ({ page }) => {
  addUser("boss@example.com", "admin");
  await logIn(page, "boss@example.com");
  await page.goto("admin/club/?id=00000000-0000-4000-8000-000000000000");
  await expect(page.getByTestId("form-error")).toHaveText("This club doesn't exist.");
});
