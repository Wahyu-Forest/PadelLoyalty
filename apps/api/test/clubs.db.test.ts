/**
 * #56 Club and court setup, against the real test database.
 * Contract: docs/api/clubs.md.
 */
import {
  adminClubDetailResponseSchema,
  adminClubListResponseSchema,
  apiErrorResponseSchema,
  clubResponseSchema,
  courtBlockListResponseSchema,
  courtResponseSchema,
  pricingResponseSchema,
  publicClubDetailResponseSchema,
  publicClubListResponseSchema,
  publicCourtBlockListResponseSchema,
  type ApiErrorCode,
  type CreateClubRequest,
  type OpeningHours,
} from "@padelloyalty/shared";
import { eq, sql } from "drizzle-orm";
import type { LightMyRequestResponse } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { describePromotion, promoteToAdmin } from "../src/admin/promote.js";
import type { DatabaseConnection } from "../src/db/client.js";
import { courtBlocks, users } from "../src/db/schema.js";
import {
  PASSWORD,
  buildAuthApp,
  connectTestDatabase,
  resetAuthTables,
  type TestApp,
} from "./support/auth-app.js";

const NOW = new Date("2026-11-24T12:00:00.000Z");
const ADMIN = "admin@example.com";

const WEEK: OpeningHours = {
  mon: { opens: "07:00", closes: "23:00" },
  tue: { opens: "07:00", closes: "23:00" },
  wed: { opens: "07:00", closes: "23:00" },
  thu: { opens: "07:00", closes: "23:00" },
  fri: { opens: "07:00", closes: "23:00" },
  sat: { opens: "08:00", closes: "20:00" },
  sun: null,
};

const CLUB: CreateClubRequest = {
  name: "Soul Padel Battersea",
  address: "1 Riverside, London SW11",
  timeZone: "Europe/London",
  openingHours: WEEK,
};

const PRICING = {
  slotLengthsMinutes: [90, 60],
  standardPrices: [
    { minutes: 60, amountMinor: 3000 },
    { minutes: 90, amountMinor: 4200 },
  ],
  bands: [
    {
      label: "Peak",
      days: ["fri", "mon", "tue", "wed", "thu"],
      starts: "17:00",
      ends: "22:00",
      prices: [
        { minutes: 90, amountMinor: 5600 },
        { minutes: 60, amountMinor: 4000 },
      ],
    },
  ],
};

let connection: DatabaseConnection;
let t: TestApp;
let adminToken: string;

beforeAll(async () => {
  connection = await connectTestDatabase();
});
afterAll(async () => {
  await connection?.pool.end();
});
beforeEach(async () => {
  await connection.db.execute(sql`truncate table court_blocks, courts, clubs cascade`);
  await resetAuthTables(connection);
  t = await buildAuthApp(connection);
  t.clock.current = new Date(NOW);
  await t.signUpVerified(ADMIN);
  expect((await promoteToAdmin(connection.db, ADMIN)).outcome).toBe("promoted");
  adminToken = (await t.post("/auth/login", { email: ADMIN, password: PASSWORD })).json()
    .accessToken as string;
});
afterEach(async () => {
  await t.app.close();
});

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

function call(method: Method, url: string, body?: unknown, token: string | null = adminToken) {
  return t.app.inject({
    method,
    url,
    ...(body !== undefined ? { payload: body as object } : {}),
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

function expectError(response: LightMyRequestResponse, status: number, code: ApiErrorCode) {
  expect(response.statusCode, response.body).toBe(status);
  const body = apiErrorResponseSchema.parse(response.json());
  expect(body.error.code).toBe(code);
  return body.error;
}

async function createClub(overrides: Partial<CreateClubRequest> = {}) {
  const response = await call("POST", "/admin/clubs", { ...CLUB, ...overrides });
  expect(response.statusCode, response.body).toBe(201);
  return clubResponseSchema.parse(response.json()).club;
}

async function createCourt(clubId: string, name: string, environment = "indoor") {
  const response = await call("POST", `/admin/clubs/${clubId}/courts`, { name, environment });
  expect(response.statusCode, response.body).toBe(201);
  return courtResponseSchema.parse(response.json()).court;
}

async function tokenWithRole(email: string, role: "member" | "receptionist" | "club_manager") {
  const session = await t.signUpVerified(email);
  await connection.db.update(users).set({ role }).where(eq(users.email, email));
  return session.accessToken;
}

describe("access control", () => {
  const adminRoutes: [Method, string][] = [
    ["GET", "/admin/clubs"],
    ["POST", "/admin/clubs"],
    ["GET", "/admin/clubs/00000000-0000-4000-8000-000000000000"],
    ["PATCH", "/admin/clubs/00000000-0000-4000-8000-000000000000"],
    ["POST", "/admin/clubs/00000000-0000-4000-8000-000000000000/courts"],
    ["PUT", "/admin/clubs/00000000-0000-4000-8000-000000000000/pricing"],
    ["POST", "/admin/clubs/00000000-0000-4000-8000-000000000000/blocks"],
  ];

  it.each(adminRoutes)("%s %s needs a token (401)", async (method, url) => {
    expectError(
      await call(method, url, method === "GET" ? undefined : {}, null),
      401,
      "unauthorized",
    );
  });

  it.each(["member", "receptionist", "club_manager"] as const)(
    "refuses a %s with 403 forbidden on every admin route",
    async (role) => {
      const club = await createClub();
      const token = await tokenWithRole(`${role}@example.com`, role);
      for (const [method, url] of [
        ...adminRoutes,
        ["GET", `/admin/clubs/${club.id}`],
        ["PATCH", `/admin/clubs/${club.id}`],
        ["DELETE", `/admin/clubs/${club.id}/pricing`],
      ] as [Method, string][]) {
        const response = await call(
          method,
          url,
          method === "GET" || method === "DELETE" ? undefined : { name: "x" },
          token,
        );
        expectError(response, 403, "forbidden");
      }
      // Nothing changed.
      const detail = await call("GET", `/admin/clubs/${club.id}`);
      expect(detail.json().club.name).toBe(CLUB.name);
    },
  );

  it("refuses an admin whose account is not active (403 account_not_active)", async () => {
    await t.post("/auth/signup", { email: "new-admin@example.com", password: PASSWORD });
    await connection.db
      .update(users)
      .set({ role: "admin" })
      .where(eq(users.email, "new-admin@example.com"));
    const login = await t.post("/auth/login", {
      email: "new-admin@example.com",
      password: PASSWORD,
    });
    const token = login.json().accessToken as string;
    expectError(await call("GET", "/admin/clubs", undefined, token), 403, "account_not_active");
  });

  it("answers 404 for ids that are not UUIDs", async () => {
    expectError(await call("GET", "/admin/clubs/not-a-uuid"), 404, "not_found");
    expectError(
      await call("GET", "/admin/clubs/00000000-0000-4000-8000-000000000000"),
      404,
      "not_found",
    );
    expectError(await call("GET", "/clubs/nope"), 404, "not_found");
  });

  it("allows PATCH, PUT and DELETE in CORS preflights", async () => {
    const response = await t.app.inject({
      method: "OPTIONS",
      url: "/admin/clubs/x",
      headers: {
        origin: "https://wahyu-forest.github.io",
        "access-control-request-method": "PATCH",
      },
    });
    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-methods"]).toContain("PATCH");
    expect(response.headers["access-control-allow-methods"]).toContain("DELETE");
    expect(response.headers["access-control-allow-methods"]).toContain("PUT");
  });
});

describe("first admin (promoteToAdmin)", () => {
  it("promotes only existing, verified accounts, and is idempotent", async () => {
    expect((await promoteToAdmin(connection.db, "nobody@example.com")).outcome).toBe("not_found");
    await t.post("/auth/signup", { email: "fresh@example.com", password: PASSWORD });
    expect((await promoteToAdmin(connection.db, "fresh@example.com")).outcome).toBe("not_verified");
    expect((await promoteToAdmin(connection.db, " ADMIN@Example.com ")).outcome).toBe(
      "already_admin",
    );
    expect((await promoteToAdmin(connection.db, "not an email")).outcome).toBe("invalid_email");

    await t.signUpVerified("member@example.com");
    const result = await promoteToAdmin(connection.db, "Member@Example.com");
    expect(result).toEqual({
      outcome: "promoted",
      email: "member@example.com",
      previousRole: "member",
    });
    expect(describePromotion(result).ok).toBe(true);
    expect(describePromotion({ outcome: "not_found", email: "x@example.com" }).ok).toBe(false);
  });

  it("takes effect on the user's next request without logging in again", async () => {
    const session = await t.signUpVerified("soon-admin@example.com");
    expectError(
      await call("GET", "/admin/clubs", undefined, session.accessToken),
      403,
      "forbidden",
    );
    await promoteToAdmin(connection.db, "soon-admin@example.com");
    expect((await call("GET", "/admin/clubs", undefined, session.accessToken)).statusCode).toBe(
      200,
    );
  });
});

describe("clubs", () => {
  it("creates a club with defaults (GBP, active) and lists it", async () => {
    const club = await createClub();
    expect(club).toMatchObject({
      name: CLUB.name,
      address: CLUB.address,
      timeZone: "Europe/London",
      currency: "GBP",
      active: true,
      openingHours: WEEK,
    });
    const listResponse = await call("GET", "/admin/clubs");
    // Opening hours come back Monday first (jsonb would otherwise reorder the keys).
    expect(Object.keys(listResponse.json().clubs[0].openingHours)).toEqual([
      "mon",
      "tue",
      "wed",
      "thu",
      "fri",
      "sat",
      "sun",
    ]);
    const list = adminClubListResponseSchema.parse(listResponse.json());
    expect(list.clubs).toHaveLength(1);
    expect(list.clubs[0]).toMatchObject({ id: club.id, courtCount: 0, hasPricing: false });
  });

  it("accepts another currency and time zone, upper-casing the currency", async () => {
    const club = await createClub({
      name: "Soul Padel Jakarta",
      currency: "idr",
      timeZone: "Asia/Jakarta",
    });
    expect(club).toMatchObject({ currency: "IDR", timeZone: "Asia/Jakarta" });
  });

  it.each([
    ["an offset instead of a zone", { timeZone: "+01:00" }, "timeZone"],
    ["an abbreviation", { timeZone: "BST" }, "timeZone"],
    ["an unknown zone", { timeZone: "Europe/Atlantis" }, "timeZone"],
    ["a bad currency", { currency: "POUNDS" }, "currency"],
    ["an empty name", { name: "  " }, "name"],
    ["a missing address", { address: undefined }, "address"],
    [
      "closing before opening",
      { openingHours: { ...WEEK, mon: { opens: "22:00", closes: "08:00" } } },
      "openingHours",
    ],
    [
      "opening equal to closing",
      { openingHours: { ...WEEK, tue: { opens: "09:00", closes: "09:00" } } },
      "openingHours",
    ],
    ["a missing weekday", { openingHours: { ...WEEK, sun: undefined } }, "openingHours"],
    [
      "a time off the quarter-hour grid",
      { openingHours: { ...WEEK, mon: { opens: "07:10", closes: "23:00" } } },
      "openingHours",
    ],
    [
      "a malformed time",
      { openingHours: { ...WEEK, mon: { opens: "7am", closes: "23:00" } } },
      "openingHours",
    ],
    [
      "opening at 24:00",
      { openingHours: { ...WEEK, mon: { opens: "24:00", closes: "24:00" } } },
      "openingHours",
    ],
  ])("rejects %s (400 on %s)", async (_name, overrides, field) => {
    const error = expectError(
      await call("POST", "/admin/clubs", { ...CLUB, ...overrides }),
      400,
      "validation_error",
    );
    expect(error.fieldErrors?.[field]).toBeDefined();
  });

  it("names the day in opening-hours errors", async () => {
    const error = expectError(
      await call("POST", "/admin/clubs", {
        ...CLUB,
        openingHours: { ...WEEK, wed: { opens: "20:00", closes: "10:00" } },
      }),
      400,
      "validation_error",
    );
    expect(error.fieldErrors?.openingHours?.join(" ")).toContain("Wednesday");
  });

  it("accepts closing at 24:00", async () => {
    const club = await createClub({
      openingHours: { ...WEEK, sat: { opens: "06:00", closes: "24:00" } },
    });
    expect(club.openingHours.sat).toEqual({ opens: "06:00", closes: "24:00" });
  });

  it("refuses a duplicate name, ignoring case (409 club_name_taken)", async () => {
    await createClub();
    expectError(
      await call("POST", "/admin/clubs", { ...CLUB, name: CLUB.name.toUpperCase() }),
      409,
      "club_name_taken",
    );
    const other = await createClub({ name: "Other" });
    expectError(
      await call("PATCH", `/admin/clubs/${other.id}`, { name: CLUB.name }),
      409,
      "club_name_taken",
    );
  });

  it("edits name, address, hours and active, keeping other fields", async () => {
    const club = await createClub();
    t.clock.advance(60_000);
    const hours = { ...WEEK, sun: { opens: "09:00", closes: "18:00" } };
    const response = await call("PATCH", `/admin/clubs/${club.id}`, {
      name: "Soul Padel Clapham",
      address: "2 Common Rd",
      openingHours: hours,
      active: false,
    });
    expect(response.statusCode, response.body).toBe(200);
    const updated = clubResponseSchema.parse(response.json()).club;
    expect(updated).toMatchObject({
      name: "Soul Padel Clapham",
      address: "2 Common Rd",
      openingHours: hours,
      active: false,
      timeZone: "Europe/London",
    });
    expect(Date.parse(updated.updatedAt)).toBeGreaterThan(Date.parse(club.updatedAt));
  });

  it("refuses a currency change while prices exist, allows it after removing them", async () => {
    const club = await createClub();
    expect((await call("PUT", `/admin/clubs/${club.id}/pricing`, PRICING)).statusCode).toBe(200);
    expectError(
      await call("PATCH", `/admin/clubs/${club.id}`, { currency: "EUR" }),
      409,
      "currency_locked",
    );
    // Same currency is not a change.
    expect((await call("PATCH", `/admin/clubs/${club.id}`, { currency: "gbp" })).statusCode).toBe(
      200,
    );
    expect((await call("DELETE", `/admin/clubs/${club.id}/pricing`)).statusCode).toBe(204);
    const response = await call("PATCH", `/admin/clubs/${club.id}`, { currency: "EUR" });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().club.currency).toBe("EUR");
  });

  it("answers 404 for an unknown club", async () => {
    const missing = "11111111-1111-4111-8111-111111111111";
    expectError(await call("PATCH", `/admin/clubs/${missing}`, { name: "X" }), 404, "not_found");
    expectError(await call("PUT", `/admin/clubs/${missing}/pricing`, PRICING), 404, "not_found");
    expectError(
      await call("POST", `/admin/clubs/${missing}/courts`, { name: "1", environment: "indoor" }),
      404,
      "not_found",
    );
  });
});

describe("courts", () => {
  it("adds, edits and deactivates courts; the admin view lists all, members see active ones", async () => {
    const club = await createClub();
    const one = await createCourt(club.id, "Court 1");
    const two = await createCourt(club.id, "Court 2", "outdoor");
    expect(one).toMatchObject({
      clubId: club.id,
      name: "Court 1",
      environment: "indoor",
      active: true,
    });

    const edited = await call("PATCH", `/admin/clubs/${club.id}/courts/${two.id}`, {
      name: "Court 2 (panoramic)",
      environment: "indoor",
    });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(edited.json().court).toMatchObject({
      name: "Court 2 (panoramic)",
      environment: "indoor",
    });

    const off = await call("PATCH", `/admin/clubs/${club.id}/courts/${one.id}`, { active: false });
    expect(off.json().court.active).toBe(false);

    const admin = adminClubDetailResponseSchema.parse(
      (await call("GET", `/admin/clubs/${club.id}`)).json(),
    );
    expect(admin.courts.map((c) => [c.name, c.active])).toEqual([
      ["Court 1", false],
      ["Court 2 (panoramic)", true],
    ]);
    const list = adminClubListResponseSchema.parse((await call("GET", "/admin/clubs")).json());
    expect(list.clubs[0]).toMatchObject({ courtCount: 2, activeCourtCount: 1 });

    const pub = publicClubDetailResponseSchema.parse(
      (await call("GET", `/clubs/${club.id}`, undefined, null)).json(),
    );
    expect(pub.courts.map((c) => c.id)).toEqual([two.id]);

    // Reactivate.
    const on = await call("PATCH", `/admin/clubs/${club.id}/courts/${one.id}`, { active: true });
    expect(on.json().court.active).toBe(true);
  });

  it("deactivating a court keeps its blocks", async () => {
    const club = await createClub();
    const court = await createCourt(club.id, "Court 1");
    await call("POST", `/admin/clubs/${club.id}/blocks`, {
      courtIds: [court.id],
      startsLocal: "2026-12-01T09:00",
      endsLocal: "2026-12-01T10:00",
      reason: "maintenance",
    });
    await call("PATCH", `/admin/clubs/${club.id}/courts/${court.id}`, { active: false });
    const blocks = courtBlockListResponseSchema.parse(
      (await call("GET", `/admin/clubs/${club.id}/blocks`)).json(),
    );
    expect(blocks.blocks).toHaveLength(1);
    // The database refuses to delete a court with history.
    await expect(
      connection.db.execute(sql`delete from courts where id = ${court.id}`),
    ).rejects.toThrow();
  });

  it("refuses duplicate court names within a club, ignoring case, but allows them across clubs", async () => {
    const club = await createClub();
    const other = await createClub({ name: "Other club" });
    await createCourt(club.id, "Court 1");
    const two = await createCourt(club.id, "Court 2");
    expectError(
      await call("POST", `/admin/clubs/${club.id}/courts`, {
        name: "court 1",
        environment: "outdoor",
      }),
      409,
      "court_name_taken",
    );
    expectError(
      await call("PATCH", `/admin/clubs/${club.id}/courts/${two.id}`, { name: "COURT 1" }),
      409,
      "court_name_taken",
    );
    await createCourt(other.id, "Court 1");
  });

  it("validates court fields", async () => {
    const club = await createClub();
    const error = expectError(
      await call("POST", `/admin/clubs/${club.id}/courts`, { name: "", environment: "roof" }),
      400,
      "validation_error",
    );
    expect(Object.keys(error.fieldErrors ?? {}).sort()).toEqual(["environment", "name"]);
    expectError(
      await call("POST", `/admin/clubs/${club.id}/courts`, {
        name: "C",
        environment: "indoor",
        active: "no",
      }),
      400,
      "validation_error",
    );
  });

  it("answers 404 for a court of another club", async () => {
    const club = await createClub();
    const other = await createClub({ name: "Other" });
    const court = await createCourt(other.id, "Court 1");
    expectError(
      await call("PATCH", `/admin/clubs/${club.id}/courts/${court.id}`, { active: false }),
      404,
      "not_found",
    );
  });
});

describe("slot lengths and prices", () => {
  it("saves pricing and returns it normalised (sorted)", async () => {
    const club = await createClub();
    const response = await call("PUT", `/admin/clubs/${club.id}/pricing`, PRICING);
    expect(response.statusCode, response.body).toBe(200);
    const { pricing } = pricingResponseSchema.parse(response.json());
    expect(pricing.slotLengthsMinutes).toEqual([60, 90]);
    expect(pricing.bands[0]!.days).toEqual(["mon", "tue", "wed", "thu", "fri"]);
    expect(pricing.bands[0]!.prices).toEqual([
      { minutes: 60, amountMinor: 4000 },
      { minutes: 90, amountMinor: 5600 },
    ]);
    const detail = adminClubDetailResponseSchema.parse(
      (await call("GET", `/admin/clubs/${club.id}`)).json(),
    );
    expect(detail.pricing).toEqual(pricing);
    const pub = publicClubDetailResponseSchema.parse(
      (await call("GET", `/clubs/${club.id}`, undefined, null)).json(),
    );
    expect(pub.pricing).toEqual(pricing);
  });

  it("accepts standard prices only (no bands)", async () => {
    const club = await createClub();
    const response = await call("PUT", `/admin/clubs/${club.id}/pricing`, {
      slotLengthsMinutes: [60],
      standardPrices: [{ minutes: 60, amountMinor: 0 }],
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().pricing.bands).toEqual([]);
  });

  it.each([
    [
      "overlapping bands",
      {
        bands: [
          ...PRICING.bands,
          { ...PRICING.bands[0]!, label: "Evening", days: ["mon"], starts: "21:00", ends: "23:00" },
        ],
      },
      "bands",
    ],
    [
      "a band ending before it starts",
      { bands: [{ ...PRICING.bands[0]!, starts: "18:00", ends: "17:00" }] },
      "bands",
    ],
    [
      "a band missing a slot length price",
      { bands: [{ ...PRICING.bands[0]!, prices: [{ minutes: 60, amountMinor: 4000 }] }] },
      "bands",
    ],
    ["a band with no days", { bands: [{ ...PRICING.bands[0]!, days: [] }] }, "bands"],
    [
      "a standard price missing",
      { standardPrices: [{ minutes: 60, amountMinor: 3000 }] },
      "standardPrices",
    ],
    [
      "a price for a length not offered",
      { standardPrices: [...PRICING.standardPrices, { minutes: 120, amountMinor: 1 }] },
      "standardPrices",
    ],
    [
      "a decimal amount",
      {
        standardPrices: [
          { minutes: 60, amountMinor: 30.5 },
          { minutes: 90, amountMinor: 4200 },
        ],
      },
      "standardPrices",
    ],
    [
      "a negative amount",
      {
        standardPrices: [
          { minutes: 60, amountMinor: -1 },
          { minutes: 90, amountMinor: 4200 },
        ],
      },
      "standardPrices",
    ],
    [
      "an amount sent as a string",
      {
        standardPrices: [
          { minutes: 60, amountMinor: "3000" },
          { minutes: 90, amountMinor: 4200 },
        ],
      },
      "standardPrices",
    ],
    ["no slot lengths", { slotLengthsMinutes: [] }, "slotLengthsMinutes"],
    [
      "a slot length off the 15-minute grid",
      { slotLengthsMinutes: [60, 100] },
      "slotLengthsMinutes",
    ],
    ["a duplicated slot length", { slotLengthsMinutes: [60, 60, 90] }, "slotLengthsMinutes"],
    ["a too-short slot", { slotLengthsMinutes: [15, 90] }, "slotLengthsMinutes"],
  ])("rejects %s (400 on %s)", async (_name, overrides, field) => {
    const club = await createClub();
    const error = expectError(
      await call("PUT", `/admin/clubs/${club.id}/pricing`, { ...PRICING, ...overrides }),
      400,
      "validation_error",
    );
    expect(error.fieldErrors?.[field], JSON.stringify(error)).toBeDefined();
  });

  it("removes pricing (idempotent)", async () => {
    const club = await createClub();
    await call("PUT", `/admin/clubs/${club.id}/pricing`, PRICING);
    expect((await call("DELETE", `/admin/clubs/${club.id}/pricing`)).statusCode).toBe(204);
    expect((await call("DELETE", `/admin/clubs/${club.id}/pricing`)).statusCode).toBe(204);
    expect((await call("GET", `/admin/clubs/${club.id}`)).json().pricing).toBeNull();
  });
});

describe("court blocks", () => {
  async function clubWithCourts() {
    const club = await createClub();
    const one = await createCourt(club.id, "Court 1");
    const two = await createCourt(club.id, "Court 2");
    return { club, one, two };
  }

  it("blocks several courts at once, converting club-local times to UTC", async () => {
    const { club, one, two } = await clubWithCourts();
    const response = await call("POST", `/admin/clubs/${club.id}/blocks`, {
      courtIds: [two.id, one.id],
      startsLocal: "2026-12-12T09:00",
      endsLocal: "2026-12-12T14:00",
      reason: "event",
      note: "  Christmas tournament ",
    });
    expect(response.statusCode, response.body).toBe(201);
    const { blocks } = courtBlockListResponseSchema.parse(response.json());
    expect(blocks.map((b) => b.courtId)).toEqual([one.id, two.id]);
    expect(blocks[0]).toMatchObject({
      clubId: club.id,
      reason: "event",
      note: "Christmas tournament",
      startsAt: "2026-12-12T09:00:00.000Z", // GMT in winter
      endsAt: "2026-12-12T14:00:00.000Z",
      startsLocal: "2026-12-12T09:00",
      endsLocal: "2026-12-12T14:00",
      cancelledAt: null,
    });
  });

  it("uses the club's time zone, including summer time", async () => {
    const { club, one } = await clubWithCourts();
    const summer = await call("POST", `/admin/clubs/${club.id}/blocks`, {
      courtIds: [one.id],
      startsLocal: "2027-07-01T09:00",
      endsLocal: "2027-07-01T10:30",
      reason: "maintenance",
    });
    expect(summer.json().blocks[0]).toMatchObject({
      startsAt: "2027-07-01T08:00:00.000Z",
      endsAt: "2027-07-01T09:30:00.000Z",
    });

    const jakarta = await createClub({
      name: "Jakarta",
      timeZone: "Asia/Jakarta",
      currency: "IDR",
    });
    const court = await createCourt(jakarta.id, "A");
    const response = await call("POST", `/admin/clubs/${jakarta.id}/blocks`, {
      courtIds: [court.id],
      startsLocal: "2026-12-01T09:00",
      endsLocal: "2026-12-01T10:00",
      reason: "other",
    });
    expect(response.json().blocks[0]).toMatchObject({
      startsAt: "2026-12-01T02:00:00.000Z",
      note: null,
    });
  });

  it("rejects a start time skipped by the clocks going forward", async () => {
    const { club, one } = await clubWithCourts();
    const error = expectError(
      await call("POST", `/admin/clubs/${club.id}/blocks`, {
        courtIds: [one.id],
        startsLocal: "2027-03-28T01:30",
        endsLocal: "2027-03-28T03:00",
        reason: "maintenance",
      }),
      400,
      "validation_error",
    );
    expect(error.fieldErrors?.startsLocal?.[0]).toContain("Europe/London");
  });

  it("uses the earlier instant for a repeated time when the clocks go back", async () => {
    const { club, one } = await clubWithCourts();
    const response = await call("POST", `/admin/clubs/${club.id}/blocks`, {
      courtIds: [one.id],
      startsLocal: "2026-10-25T01:30",
      endsLocal: "2026-10-25T02:30",
      reason: "maintenance",
    });
    // 01:30 BST = 00:30Z; 02:30 GMT = 02:30Z.
    expect(response.json().blocks[0]).toMatchObject({
      startsAt: "2026-10-25T00:30:00.000Z",
      endsAt: "2026-10-25T02:30:00.000Z",
    });
  });

  it.each([
    [
      "end before start",
      { startsLocal: "2026-12-01T10:00", endsLocal: "2026-12-01T09:00" },
      "endsLocal",
    ],
    [
      "end equal to start",
      { startsLocal: "2026-12-01T10:00", endsLocal: "2026-12-01T10:00" },
      "endsLocal",
    ],
    ["a malformed time", { startsLocal: "2026-12-01 10:00" }, "startsLocal"],
    ["an impossible date", { endsLocal: "2026-02-30T10:00" }, "endsLocal"],
    ["an unknown reason", { reason: "party" }, "reason"],
    ["no courts", { courtIds: [] }, "courtIds"],
    ["a too-long note", { note: "x".repeat(201) }, "note"],
  ])("rejects %s (400 on %s)", async (_name, overrides, field) => {
    const { club, one } = await clubWithCourts();
    const error = expectError(
      await call("POST", `/admin/clubs/${club.id}/blocks`, {
        courtIds: [one.id],
        startsLocal: "2026-12-01T09:00",
        endsLocal: "2026-12-01T10:00",
        reason: "maintenance",
        ...overrides,
      }),
      400,
      "validation_error",
    );
    expect(error.fieldErrors?.[field], JSON.stringify(error)).toBeDefined();
  });

  it("rejects courts of another club, creating nothing", async () => {
    const { club, one } = await clubWithCourts();
    const other = await createClub({ name: "Other" });
    const foreign = await createCourt(other.id, "X");
    const error = expectError(
      await call("POST", `/admin/clubs/${club.id}/blocks`, {
        courtIds: [one.id, foreign.id],
        startsLocal: "2026-12-01T09:00",
        endsLocal: "2026-12-01T10:00",
        reason: "maintenance",
      }),
      400,
      "validation_error",
    );
    expect(error.fieldErrors?.courtIds).toBeDefined();
    expect(await connection.db.select().from(courtBlocks)).toHaveLength(0);
  });

  it("lists upcoming blocks by default, filters, and cancels (idempotent, kept on record)", async () => {
    const { club, one, two } = await clubWithCourts();
    const make = (courtIds: string[], startsLocal: string, endsLocal: string) =>
      call("POST", `/admin/clubs/${club.id}/blocks`, {
        courtIds,
        startsLocal,
        endsLocal,
        reason: "maintenance",
      });
    await make([one.id], "2026-11-20T09:00", "2026-11-20T10:00"); // past (NOW is 2026-11-24)
    const current = (await make([two.id], "2026-11-24T11:00", "2026-11-24T13:00")).json().blocks[0];
    const future = (await make([one.id], "2026-12-05T09:00", "2026-12-05T10:00")).json().blocks[0];

    const upcoming = courtBlockListResponseSchema.parse(
      (await call("GET", `/admin/clubs/${club.id}/blocks`)).json(),
    );
    expect(upcoming.blocks.map((b) => b.id)).toEqual([current.id, future.id]);

    const all = await call("GET", `/admin/clubs/${club.id}/blocks?from=2026-01-01T00:00:00Z`);
    expect(all.json().blocks).toHaveLength(3);
    const windowed = await call(
      "GET",
      `/admin/clubs/${club.id}/blocks?from=2026-11-24T00:00:00Z&to=2026-11-25T00:00:00Z`,
    );
    expect(windowed.json().blocks.map((b: { id: string }) => b.id)).toEqual([current.id]);
    const byCourt = await call("GET", `/admin/clubs/${club.id}/blocks?courtId=${one.id}`);
    expect(byCourt.json().blocks.map((b: { id: string }) => b.id)).toEqual([future.id]);
    expectError(
      await call("GET", `/admin/clubs/${club.id}/blocks?from=yesterday`),
      400,
      "validation_error",
    );

    expect((await call("DELETE", `/admin/clubs/${club.id}/blocks/${future.id}`)).statusCode).toBe(
      204,
    );
    expect((await call("DELETE", `/admin/clubs/${club.id}/blocks/${future.id}`)).statusCode).toBe(
      204,
    );
    expect((await call("GET", `/admin/clubs/${club.id}/blocks`)).json().blocks).toHaveLength(1);
    const withCancelled = courtBlockListResponseSchema.parse(
      (await call("GET", `/admin/clubs/${club.id}/blocks?includeCancelled=true`)).json(),
    );
    expect(withCancelled.blocks.find((b) => b.id === future.id)?.cancelledAt).toBe(
      NOW.toISOString(),
    );

    const other = await createClub({ name: "Other" });
    expectError(
      await call("DELETE", `/admin/clubs/${other.id}/blocks/${current.id}`),
      404,
      "not_found",
    );
  });

  it("findBlockingBlocks reports overlapping, non-cancelled blocks (for booking, #23)", async () => {
    const { club, one, two } = await clubWithCourts();
    const created = await call("POST", `/admin/clubs/${club.id}/blocks`, {
      courtIds: [one.id],
      startsLocal: "2026-12-01T10:00",
      endsLocal: "2026-12-01T12:00",
      reason: "maintenance",
    });
    const block = created.json().blocks[0];
    const clubs = t.app.clubService!;
    const at = (h: string) => new Date(`2026-12-01T${h}:00.000Z`);
    expect(await clubs.findBlockingBlocks(one.id, at("09:00"), at("10:00"))).toHaveLength(0); // ends as block starts
    expect(await clubs.findBlockingBlocks(one.id, at("09:30"), at("10:30"))).toHaveLength(1);
    expect(await clubs.findBlockingBlocks(one.id, at("11:30"), at("13:00"))).toHaveLength(1);
    expect(await clubs.findBlockingBlocks(one.id, at("12:00"), at("13:00"))).toHaveLength(0);
    expect(await clubs.findBlockingBlocks(two.id, at("10:00"), at("12:00"))).toHaveLength(0);
    await call("DELETE", `/admin/clubs/${club.id}/blocks/${block.id}`);
    expect(await clubs.findBlockingBlocks(one.id, at("10:00"), at("12:00"))).toHaveLength(0);
  });
});

describe("public reads", () => {
  it("lists only active clubs, ordered by name, without auth", async () => {
    await createClub({ name: "Zeta" });
    const hidden = await createClub({ name: "Hidden", active: false });
    await createClub({ name: "alpha" });
    const response = await call("GET", "/clubs", undefined, null);
    expect(response.statusCode).toBe(200);
    const { clubs } = publicClubListResponseSchema.parse(response.json());
    expect(clubs.map((c) => c.name)).toEqual(["alpha", "Zeta"]);
    expectError(await call("GET", `/clubs/${hidden.id}`, undefined, null), 404, "not_found");
    expectError(
      await call(
        "GET",
        `/clubs/${hidden.id}/blocks?from=2026-12-01T00:00:00Z&to=2026-12-02T00:00:00Z`,
        undefined,
        null,
      ),
      404,
      "not_found",
    );
  });

  it("shows a club without pricing as pricing: null", async () => {
    const club = await createClub();
    const pub = publicClubDetailResponseSchema.parse(
      (await call("GET", `/clubs/${club.id}`, undefined, null)).json(),
    );
    expect(pub.pricing).toBeNull();
  });

  it("lists blocks on active courts in a window, without reasons", async () => {
    const club = await createClub();
    const one = await createCourt(club.id, "Court 1");
    const two = await createCourt(club.id, "Court 2");
    await call("POST", `/admin/clubs/${club.id}/blocks`, {
      courtIds: [one.id, two.id],
      startsLocal: "2026-12-01T10:00",
      endsLocal: "2026-12-01T12:00",
      reason: "event",
      note: "secret",
    });
    await call("PATCH", `/admin/clubs/${club.id}/courts/${two.id}`, { active: false });
    const response = await call(
      "GET",
      `/clubs/${club.id}/blocks?from=2026-12-01T00:00:00Z&to=2026-12-02T00:00:00Z`,
      undefined,
      null,
    );
    expect(response.statusCode, response.body).toBe(200);
    const { blocks } = publicCourtBlockListResponseSchema.parse(response.json());
    expect(blocks).toEqual([
      { courtId: one.id, startsAt: "2026-12-01T10:00:00.000Z", endsAt: "2026-12-01T12:00:00.000Z" },
    ]);
    expect(response.body).not.toContain("secret");

    const outside = await call(
      "GET",
      `/clubs/${club.id}/blocks?from=2026-12-01T12:00:00Z&to=2026-12-02T00:00:00Z`,
      undefined,
      null,
    );
    expect(outside.json().blocks).toEqual([]);
  });

  it.each([
    ["missing to", "?from=2026-12-01T00:00:00Z"],
    ["to before from", "?from=2026-12-02T00:00:00Z&to=2026-12-01T00:00:00Z"],
    ["more than 62 days", "?from=2026-12-01T00:00:00Z&to=2027-02-02T00:00:00Z"],
    ["not a date-time", "?from=monday&to=tuesday"],
  ])("validates the blocks window: %s", async (_name, query) => {
    const club = await createClub();
    expectError(
      await call("GET", `/clubs/${club.id}/blocks${query}`, undefined, null),
      400,
      "validation_error",
    );
  });
});
