import type { Court, UserRole } from "@padelloyalty/shared";
import { expect, test, type Page } from "@playwright/test";
import { resolveBasePath } from "../src/lib/base-path";
import { FakeAuthApi } from "./support/fake-auth-api";
import { FakeClubsApi } from "./support/fake-clubs-api";

// QA (Quan) e2e for #56, on top of clubs.spec.ts: the back-office gate for
// every role and status, the ?next= redirect after login, money entry in other
// currencies, and block times in the club's time zone whatever the device's
// zone. Desktop and phone, root and base path. The API is the contract fake.
const basePath = resolveBasePath(process.env.NEXT_PUBLIC_BASE_PATH);
const PASSWORD = "correct horse battery";

// The device is in New York; the clubs are elsewhere. Nothing may use the device's zone.
test.use({ timezoneId: "America/New_York" });

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

function addUser(
  email: string,
  role: UserRole,
  status: "active" | "pending_verification" | "pending_consent" = "active",
) {
  const account = auth.addAccount(email, PASSWORD, status !== "pending_verification");
  account.user = { ...account.user, role, status };
  return account;
}

async function logIn(page: Page, email: string, query = "") {
  await page.goto(`login/${query}`);
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect.poll(() => new URL(page.url()).pathname).not.toBe(`${basePath}/login/`);
}

function seedClub(timeZone = "Europe/London", currency = "GBP") {
  const stored = clubs.addClub({ name: "QA Club", timeZone, currency });
  const at = new Date().toISOString();
  const court: Court = {
    id: crypto.randomUUID(),
    clubId: stored.club.id,
    name: "Court 1",
    environment: "indoor",
    active: true,
    createdAt: at,
    updatedAt: at,
  };
  stored.courts.push(court);
  return stored;
}

const adminCalls = () => clubs.calls.filter((c) => c.includes("/admin/clubs"));

test.describe("back-office gate by role and status", () => {
  const pages = (clubId: string) => [
    "admin/clubs/",
    "admin/clubs/new/",
    `admin/club/?id=${clubId}`,
  ];

  for (const [role, status, expected] of [
    ["member", "active", "The back office is for Soul Padel staff only."],
    ["member", "pending_verification", "The back office is for Soul Padel staff only."],
    ["member", "pending_consent", "The back office is for Soul Padel staff only."],
    ["receptionist", "active", "Club setup is for admins only."],
    ["club_manager", "active", "Club setup is for admins only."],
    ["admin", "pending_verification", "Verify your email before using the back office."],
  ] as const) {
    test(`${role} (${status}) can't open club setup and no admin API call is made`, async ({
      page,
    }) => {
      const { club } = seedClub();
      addUser("someone@example.com", role, status);
      await logIn(page, "someone@example.com");
      for (const path of pages(club.id)) {
        await page.goto(path);
        await expect(page.getByTestId("no-access"), path).toContainText(expected);
        await expect(page.getByTestId("club-list")).toHaveCount(0);
        await expect(page.getByText("QA Club")).toHaveCount(0);
      }
      expect(adminCalls()).toEqual([]);
    });
  }

  test("logging out from club setup hides it again", async ({ page }) => {
    seedClub();
    addUser("boss@example.com", "admin");
    await logIn(page, "boss@example.com");
    await page.goto("admin/clubs/");
    await expect(page.getByTestId("club-row")).toHaveCount(1);
    await page.goto("./");
    await page.getByRole("button", { name: "Log out" }).click();
    await page.goto("admin/clubs/");
    await expect(page.getByTestId("gate-login")).toBeVisible();
    await expect(page.getByTestId("club-row")).toHaveCount(0);
  });
});

test.describe("?next= after login stays inside the app", () => {
  for (const next of [
    "https://evil.example/",
    "//evil.example/",
    "/\\evil.example/",
    "javascript:alert(1)",
    "/%5Cevil.example",
    " /admin/",
  ]) {
    test(`next=${JSON.stringify(next)} does not leave the app`, async ({ page }) => {
      addUser("boss@example.com", "admin");
      await logIn(page, "boss@example.com", `?next=${encodeURIComponent(next)}`);
      const url = new URL(page.url());
      expect(url.protocol).toBe("http:");
      expect(url.hostname).toBe("localhost");
      expect(url.pathname.startsWith(`${basePath}/`)).toBe(true);
    });
  }

  test("a same-app next brings the admin back to club setup", async ({ page }) => {
    seedClub();
    addUser("boss@example.com", "admin");
    await logIn(page, "boss@example.com", `?next=${encodeURIComponent("/admin/clubs/")}`);
    await expect.poll(() => new URL(page.url()).pathname).toBe(`${basePath}/admin/clubs/`);
    await expect(page.getByTestId("club-row")).toHaveCount(1);
  });
});

test.describe("money entry", () => {
  test("negative, comma and exponent prices are refused before calling the API", async ({
    page,
  }) => {
    const { club } = seedClub();
    addUser("boss@example.com", "admin");
    await logIn(page, "boss@example.com");
    await page.goto(`admin/club/?id=${club.id}`);
    await page.getByRole("tab", { name: "Prices" }).click();
    await page.getByLabel("Standard price for 90 min").fill("42");
    for (const bad of ["-5", "1,000", "1e3", "£30"]) {
      await page.getByLabel("Standard price for 60 min").fill(bad);
      await page.getByRole("button", { name: "Save prices" }).click();
      await expect(page.getByTestId("pricing-errors"), bad).toBeVisible();
    }
    expect(clubs.calls.filter((c) => c.startsWith("PUT"))).toEqual([]);
  });

  test("a zero-decimal currency club stores whole units as minor units", async ({ page }) => {
    const stored = seedClub("Asia/Jakarta", "IDR");
    addUser("boss@example.com", "admin");
    await logIn(page, "boss@example.com");
    await page.goto(`admin/club/?id=${stored.club.id}`);
    await page.getByRole("tab", { name: "Prices" }).click();
    await page.getByLabel("Standard price for 60 min").fill("350000.50");
    await page.getByLabel("Standard price for 90 min").fill("500000");
    await page.getByRole("button", { name: "Save prices" }).click();
    await expect(page.getByTestId("pricing-errors")).toBeVisible();
    await page.getByLabel("Standard price for 60 min").fill("350000");
    await page.getByRole("button", { name: "Save prices" }).click();
    await expect(page.getByTestId("pricing-saved")).toBeVisible();
    expect(stored.pricing?.standardPrices).toEqual([
      { minutes: 60, amountMinor: 350000 },
      { minutes: 90, amountMinor: 500000 },
    ]);
  });

  test("a GBP price with pence round-trips exactly (no float drift)", async ({ page }) => {
    const stored = seedClub();
    addUser("boss@example.com", "admin");
    await logIn(page, "boss@example.com");
    await page.goto(`admin/club/?id=${stored.club.id}`);
    await page.getByRole("tab", { name: "Prices" }).click();
    // 0.1 + 0.2 style values that drift in floating point.
    await page.getByLabel("Standard price for 60 min").fill("19.99");
    await page.getByLabel("Standard price for 90 min").fill("0.30");
    await page.getByRole("button", { name: "Save prices" }).click();
    await expect(page.getByTestId("pricing-saved")).toBeVisible();
    expect(stored.pricing?.standardPrices).toEqual([
      { minutes: 60, amountMinor: 1999 },
      { minutes: 90, amountMinor: 30 },
    ]);
    await page.reload();
    await page.getByRole("tab", { name: "Prices" }).click();
    await expect(page.getByLabel("Standard price for 60 min")).toHaveValue("19.99");
    await expect(page.getByLabel("Standard price for 90 min")).toHaveValue("0.30");
  });
});

test.describe("block times use the club's time zone, not the device's", () => {
  test("a summer block in a London club is sent as London time (device in New York)", async ({
    page,
  }) => {
    const stored = seedClub("Europe/London");
    clubs.now = new Date("2026-11-24T12:00:00Z");
    addUser("boss@example.com", "admin");
    await logIn(page, "boss@example.com");
    await page.goto(`admin/club/?id=${stored.club.id}`);
    await page.getByRole("tab", { name: "Blocks" }).click();
    await page.getByRole("checkbox", { name: "Court 1" }).check();
    await page.getByLabel("From").fill("2027-07-01T10:00");
    await page.getByLabel("Until").fill("2027-07-01T11:30");
    await page.getByRole("button", { name: "Block courts" }).click();
    await expect(page.getByTestId("block-created")).toBeVisible();
    expect(stored.blocks[0]).toMatchObject({
      startsAt: "2027-07-01T09:00:00.000Z",
      endsAt: "2027-07-01T10:30:00.000Z",
    });
    const row = page.getByTestId("block-row");
    await expect(row).toContainText("10:00");
    await expect(row).toContainText("11:30");
  });

  test("a time skipped by the clocks going forward is refused with a clear message", async ({
    page,
  }) => {
    const stored = seedClub("Europe/London");
    addUser("boss@example.com", "admin");
    await logIn(page, "boss@example.com");
    await page.goto(`admin/club/?id=${stored.club.id}`);
    await page.getByRole("tab", { name: "Blocks" }).click();
    await page.getByRole("checkbox", { name: "Court 1" }).check();
    await page.getByLabel("From").fill("2027-03-28T01:30");
    await page.getByLabel("Until").fill("2027-03-28T03:00");
    await page.getByRole("button", { name: "Block courts" }).click();
    await expect(page.getByText(/doesn't exist in Europe\/London/)).toBeVisible();
    expect(stored.blocks).toEqual([]);
  });

  test("a block with no court chosen is refused", async ({ page }) => {
    const stored = seedClub();
    addUser("boss@example.com", "admin");
    await logIn(page, "boss@example.com");
    await page.goto(`admin/club/?id=${stored.club.id}`);
    await page.getByRole("tab", { name: "Blocks" }).click();
    await page.getByLabel("From").fill("2027-01-10T10:00");
    await page.getByLabel("Until").fill("2027-01-10T11:00");
    await page.getByRole("button", { name: "Block courts" }).click();
    await expect(page.getByText("Choose at least one court")).toBeVisible();
    expect(stored.blocks).toEqual([]);
  });
});
