/**
 * QA (Quan) tests for issue #56: club and court setup.
 * Contract: docs/api/clubs.md, packages/shared/src/clubs.ts.
 *
 * Runs against the real test database (TEST_DATABASE_URL). Accounts use random
 * emails and clubs random names, so nothing is truncated here. Roles other than
 * admin are set with SQL (there is no role API yet); admins are made with the
 * documented hook `promoteToAdmin`.
 */
import { randomUUID } from "node:crypto";
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
  type ClubPricingInput,
  type CreateClubRequest,
} from "@padelloyalty/shared";
import type { LightMyRequestResponse } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { promoteToAdmin } from "../src/admin/promote.js";
import type { DatabaseConnection } from "../src/db/client.js";
import {
  MINUTE,
  PASSWORD,
  activeMember,
  expectApiError,
  logIn,
  makeHarness,
  openTestDatabase,
  post,
  signUp,
  uniqueEmail,
  verify,
  type Harness,
} from "./support/auth-harness.js";

let connection: DatabaseConnection;
let h: Harness;
let admin: string;

beforeAll(async () => {
  connection = await openTestDatabase();
});
afterAll(async () => {
  await connection?.pool.end();
});
beforeEach(async () => {
  h = await makeHarness(connection);
  admin = await adminToken();
});
afterEach(async () => {
  await h.app.close();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

function call(
  method: Method,
  url: string,
  token?: string,
  payload?: unknown,
): Promise<LightMyRequestResponse> {
  return h.app.inject({
    method,
    url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
}

function expectStatus(response: LightMyRequestResponse, status: number) {
  expect(response.statusCode, response.body).toBe(status);
  return response;
}

function fieldErrors(response: LightMyRequestResponse): Record<string, string[]> {
  expectApiError(response, 400, "validation_error");
  return (apiErrorResponseSchema.parse(response.json()).error.fieldErrors ?? {}) as Record<
    string,
    string[]
  >;
}

async function adminToken(): Promise<string> {
  const m = await activeMember(h);
  await promoteToAdmin(connection.db, m.email);
  return (await logIn(h, m.email)).accessToken;
}

async function tokenWithRole(role: string): Promise<string> {
  const m = await activeMember(h);
  await connection.pool.query("update users set role = $1 where id = $2", [
    role,
    m.session.user.id,
  ]);
  return m.session.accessToken;
}

const weekHours = {
  mon: { opens: "07:00", closes: "23:00" },
  tue: { opens: "07:00", closes: "23:00" },
  wed: { opens: "07:00", closes: "23:00" },
  thu: { opens: "07:00", closes: "23:00" },
  fri: { opens: "07:00", closes: "23:00" },
  sat: { opens: "08:00", closes: "22:00" },
  sun: null,
};

function clubBody(overrides: Record<string, unknown> = {}): CreateClubRequest {
  return {
    name: `QA Club ${randomUUID().slice(0, 8)}`,
    address: "1 Court Lane, London",
    timeZone: "Europe/London",
    openingHours: weekHours,
    ...overrides,
  } as CreateClubRequest;
}

async function createClub(overrides: Record<string, unknown> = {}) {
  const response = expectStatus(
    await call("POST", "/admin/clubs", admin, clubBody(overrides)),
    201,
  );
  return clubResponseSchema.parse(response.json()).club;
}

async function createCourt(clubId: string, overrides: Record<string, unknown> = {}) {
  const response = expectStatus(
    await call("POST", `/admin/clubs/${clubId}/courts`, admin, {
      name: `Court ${randomUUID().slice(0, 6)}`,
      environment: "indoor",
      ...overrides,
    }),
    201,
  );
  return courtResponseSchema.parse(response.json()).court;
}

const pricing: ClubPricingInput = {
  slotLengthsMinutes: [90, 60],
  standardPrices: [
    { minutes: 90, amountMinor: 4200 },
    { minutes: 60, amountMinor: 3000 },
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

function band(overrides: Record<string, unknown> = {}) {
  return {
    label: `Band ${randomUUID().slice(0, 4)}`,
    days: ["mon"],
    starts: "17:00",
    ends: "19:00",
    prices: [
      { minutes: 60, amountMinor: 4000 },
      { minutes: 90, amountMinor: 5600 },
    ],
    ...overrides,
  };
}

function pricingWith(overrides: Record<string, unknown>) {
  return { ...pricing, ...overrides };
}

async function putPricing(clubId: string, body: unknown = pricing) {
  return call("PUT", `/admin/clubs/${clubId}/pricing`, admin, body);
}

async function createBlocks(clubId: string, body: Record<string, unknown>) {
  return call("POST", `/admin/clubs/${clubId}/blocks`, admin, {
    reason: "maintenance",
    ...body,
  });
}

// ---------------------------------------------------------------------------
// Role and permission matrix
// ---------------------------------------------------------------------------

describe("role guards on every admin endpoint (direct API calls)", () => {
  async function endpoints() {
    const club = await createClub();
    const court = await createCourt(club.id);
    const blocks = courtBlockListResponseSchema.parse(
      expectStatus(
        await createBlocks(club.id, {
          courtIds: [court.id],
          startsLocal: "2030-01-10T09:00",
          endsLocal: "2030-01-10T10:00",
        }),
        201,
      ).json(),
    ).blocks;
    const blockId = blocks[0]!.id;
    return {
      club,
      list: [
        ["GET", "/admin/clubs", undefined],
        ["POST", "/admin/clubs", clubBody()],
        ["GET", `/admin/clubs/${club.id}`, undefined],
        ["PATCH", `/admin/clubs/${club.id}`, { name: `Hacked ${randomUUID()}` }],
        ["POST", `/admin/clubs/${club.id}/courts`, { name: "Hacked", environment: "indoor" }],
        ["PATCH", `/admin/clubs/${club.id}/courts/${court.id}`, { active: false }],
        ["PUT", `/admin/clubs/${club.id}/pricing`, pricing],
        ["DELETE", `/admin/clubs/${club.id}/pricing`, undefined],
        ["GET", `/admin/clubs/${club.id}/blocks`, undefined],
        [
          "POST",
          `/admin/clubs/${club.id}/blocks`,
          {
            courtIds: [court.id],
            startsLocal: "2030-01-11T09:00",
            endsLocal: "2030-01-11T10:00",
            reason: "event",
          },
        ],
        ["DELETE", `/admin/clubs/${club.id}/blocks/${blockId}`, undefined],
      ] as [Method, string, unknown][],
    };
  }

  async function expectUntouched(clubId: string, name: string) {
    const detail = adminClubDetailResponseSchema.parse(
      expectStatus(await call("GET", `/admin/clubs/${clubId}`, admin), 200).json(),
    );
    expect(detail.club.name).toBe(name);
    expect(detail.courts).toHaveLength(1);
    expect(detail.courts[0]!.active).toBe(true);
    expect(detail.pricing).toBeNull();
    const blocks = courtBlockListResponseSchema.parse(
      expectStatus(
        await call("GET", `/admin/clubs/${clubId}/blocks?includeCancelled=true`, admin),
        200,
      ).json(),
    ).blocks;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.cancelledAt).toBeNull();
  }

  it("anonymous and junk tokens get 401 unauthorized and change nothing", async () => {
    const { club, list } = await endpoints();
    for (const [method, url, body] of list) {
      expectApiError(await call(method, url, undefined, body), 401, "unauthorized");
      expectApiError(await call(method, url, "pla_junk", body), 401, "unauthorized");
    }
    await expectUntouched(club.id, club.name);
  });

  it("an expired admin token gets 401", async () => {
    h.clock.advance(16 * MINUTE);
    expectApiError(await call("GET", "/admin/clubs", admin), 401, "unauthorized");
  });

  it.each(["member", "receptionist", "club_manager"])(
    "an active %s gets 403 forbidden everywhere and changes nothing",
    async (role) => {
      const { club, list } = await endpoints();
      const token = await tokenWithRole(role);
      for (const [method, url, body] of list) {
        expectApiError(await call(method, url, token, body), 403, "forbidden");
      }
      await expectUntouched(club.id, club.name);
    },
  );

  it("an unverified member (pending_verification) gets 403 forbidden", async () => {
    const { club, list } = await endpoints();
    const email = uniqueEmail();
    await signUp(h, email);
    const token = (await logIn(h, email)).accessToken;
    for (const [method, url, body] of list) {
      expectApiError(await call(method, url, token, body), 403, "forbidden");
    }
    await expectUntouched(club.id, club.name);
  });

  it("an under-18 waiting for consent (pending_consent) gets 403 forbidden", async () => {
    const { club, list } = await endpoints();
    const email = uniqueEmail("kid");
    const signup = await post(h.app, "/auth/signup", {
      email,
      password: PASSWORD,
      dateOfBirth: "2012-05-01",
      guardianEmail: uniqueEmail("guardian"),
    });
    expect(signup.statusCode, signup.body).toBe(202);
    await verify(h, email);
    const session = await logIn(h, email);
    expect(session.user.status).toBe("pending_consent");
    for (const [method, url, body] of list) {
      expectApiError(await call(method, url, session.accessToken, body), 403, "forbidden");
    }
    await expectUntouched(club.id, club.name);
  });

  it("an admin whose account is not active gets 403 account_not_active", async () => {
    const { club, list } = await endpoints();
    const email = uniqueEmail();
    await signUp(h, email);
    const session = await logIn(h, email);
    await connection.pool.query("update users set role = 'admin' where id = $1", [session.user.id]);
    for (const [method, url, body] of list) {
      expectApiError(await call(method, url, session.accessToken, body), 403, "account_not_active");
    }
    await expectUntouched(club.id, club.name);
  });

  it("a demoted admin loses access on the next request", async () => {
    const m = await activeMember(h);
    await promoteToAdmin(connection.db, m.email);
    const token = (await logIn(h, m.email)).accessToken;
    expectStatus(await call("GET", "/admin/clubs", token), 200);
    await connection.pool.query("update users set role = 'member' where id = $1", [
      m.session.user.id,
    ]);
    expectApiError(await call("GET", "/admin/clubs", token), 403, "forbidden");
  });

  it("role is checked before the club exists (no 404 leak to non-admins)", async () => {
    const token = await tokenWithRole("member");
    expectApiError(await call("GET", `/admin/clubs/${randomUUID()}`, token), 403, "forbidden");
    expectApiError(await call("GET", `/admin/clubs/${randomUUID()}`), 401, "unauthorized");
  });

  it("public endpoints need no auth", async () => {
    const club = await createClub();
    expectStatus(await call("GET", "/clubs"), 200);
    expectStatus(await call("GET", `/clubs/${club.id}`), 200);
    expectStatus(
      await call(
        "GET",
        `/clubs/${club.id}/blocks?from=2030-01-01T00:00:00Z&to=2030-01-31T00:00:00Z`,
      ),
      200,
    );
  });

  it("there is no public write route under /clubs", async () => {
    const club = await createClub();
    for (const [method, url] of [
      ["POST", "/clubs"],
      ["PATCH", `/clubs/${club.id}`],
      ["PUT", `/clubs/${club.id}/pricing`],
      ["POST", `/clubs/${club.id}/courts`],
      ["POST", `/clubs/${club.id}/blocks`],
    ] as [Method, string][]) {
      const response = await call(method, url, admin, {});
      expect([404, 405], `${method} ${url}`).toContain(response.statusCode);
    }
  });
});

// ---------------------------------------------------------------------------
// Clubs
// ---------------------------------------------------------------------------

describe("clubs", () => {
  it("creates a club with defaults (GBP, active) and trims text", async () => {
    const name = `  QA Trim ${randomUUID().slice(0, 8)}  `;
    const club = await createClub({ name, address: "  2 Net Road  " });
    expect(club.name).toBe(name.trim());
    expect(club.address).toBe("2 Net Road");
    expect(club.currency).toBe("GBP");
    expect(club.active).toBe(true);
    expect(club.timeZone).toBe("Europe/London");
    expect(club.openingHours).toEqual(weekHours);
  });

  it("upper-cases the currency and accepts a 0-decimal currency", async () => {
    expect((await createClub({ currency: "eur" })).currency).toBe("EUR");
    expect((await createClub({ currency: "IDR", timeZone: "Asia/Jakarta" })).currency).toBe("IDR");
  });

  it("admin list shows inactive clubs with counts; public list shows active only", async () => {
    const active = await createClub();
    const inactive = await createClub({ active: false });
    await createCourt(active.id);
    await createCourt(active.id, { active: false });

    const adminList = adminClubListResponseSchema.parse(
      expectStatus(await call("GET", "/admin/clubs", admin), 200).json(),
    ).clubs;
    const row = adminList.find((c) => c.id === active.id)!;
    expect(row).toMatchObject({ courtCount: 2, activeCourtCount: 1, hasPricing: false });
    expect(adminList.some((c) => c.id === inactive.id)).toBe(true);
    const names = adminList.map((c) => c.name);
    expect(names).toEqual(
      [...names].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" })),
    );

    const publicList = publicClubListResponseSchema.parse(
      expectStatus(await call("GET", "/clubs"), 200).json(),
    ).clubs;
    expect(publicList.some((c) => c.id === active.id)).toBe(true);
    expect(publicList.some((c) => c.id === inactive.id)).toBe(false);
    expectApiError(await call("GET", `/clubs/${inactive.id}`), 404, "not_found");
  });

  it("club names are unique ignoring case and surrounding spaces", async () => {
    const club = await createClub();
    for (const name of [club.name, club.name.toUpperCase(), ` ${club.name.toLowerCase()} `]) {
      expectApiError(
        await call("POST", "/admin/clubs", admin, clubBody({ name })),
        409,
        "club_name_taken",
      );
    }
    const other = await createClub();
    expectApiError(
      await call("PATCH", `/admin/clubs/${other.id}`, admin, { name: club.name.toLowerCase() }),
      409,
      "club_name_taken",
    );
    // Renaming a club to its own name in another case is fine.
    const renamed = expectStatus(
      await call("PATCH", `/admin/clubs/${club.id}`, admin, { name: club.name.toUpperCase() }),
      200,
    );
    expect(clubResponseSchema.parse(renamed.json()).club.name).toBe(club.name.toUpperCase());
  });

  it("two concurrent creates with the same name: one 201, one 409", async () => {
    const body = clubBody();
    const [a, b] = await Promise.all([
      call("POST", "/admin/clubs", admin, body),
      call("POST", "/admin/clubs", admin, { ...body, name: body.name.toUpperCase() }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
  });

  it.each([
    ["missing name", { name: undefined }, "name"],
    ["blank name", { name: "   " }, "name"],
    ["name too long", { name: "n".repeat(81) }, "name"],
    ["blank address", { address: "" }, "address"],
    ["address too long", { address: "a".repeat(301) }, "address"],
    ["offset time zone", { timeZone: "+01:00" }, "timeZone"],
    ["abbreviation time zone", { timeZone: "BST" }, "timeZone"],
    ["unknown time zone", { timeZone: "Mars/Olympus_Mons" }, "timeZone"],
    ["empty time zone", { timeZone: "" }, "timeZone"],
    ["two-letter currency", { currency: "GB" }, "currency"],
    ["numeric currency", { currency: "826" }, "currency"],
    ["four-letter currency", { currency: "GBPP" }, "currency"],
    ["non-boolean active", { active: "yes" }, "active"],
    ["missing opening hours", { openingHours: undefined }, "openingHours"],
  ])("rejects %s", async (_label, overrides, field) => {
    const body = clubBody(overrides);
    const errors = fieldErrors(await call("POST", "/admin/clubs", admin, body));
    expect(errors[field], JSON.stringify(errors)).toBeDefined();
  });

  it.each(["ABC", "QQQ", "ZZZ"])(
    "rejects %s, which is not an ISO 4217 currency code",
    async (currency) => {
      const errors = fieldErrors(await call("POST", "/admin/clubs", admin, clubBody({ currency })));
      expect(errors.currency).toBeDefined();
    },
  );

  it.each(["UTC", "Asia/Jakarta", "America/New_York", "Australia/Lord_Howe", "Asia/Kolkata"])(
    "accepts the IANA time zone %s",
    async (timeZone) => {
      expect((await createClub({ timeZone })).timeZone).toBe(timeZone);
    },
  );

  it("stores a time zone in its canonical spelling (or rejects a wrong-case one)", async () => {
    const response = await call(
      "POST",
      "/admin/clubs",
      admin,
      clubBody({ timeZone: "Europe/london" }),
    );
    if (response.statusCode === 201) {
      expect(clubResponseSchema.parse(response.json()).club.timeZone).toBe("Europe/London");
    } else {
      expect(fieldErrors(response).timeZone).toBeDefined();
    }
  });

  it.each([
    ["closing before opening", { opens: "18:00", closes: "09:00" }],
    ["closing at opening", { opens: "09:00", closes: "09:00" }],
    ["off the quarter-hour grid", { opens: "09:10", closes: "18:00" }],
    ["hour 25", { opens: "09:00", closes: "25:00" }],
    ["minute 60", { opens: "09:60", closes: "18:00" }],
    ["opening at 24:00", { opens: "24:00", closes: "24:00" }],
    ["no leading zero", { opens: "9:00", closes: "18:00" }],
    ["with seconds", { opens: "09:00:00", closes: "18:00" }],
    ["missing closes", { opens: "09:00" }],
  ])("rejects opening hours with %s", async (_label, wed) => {
    const errors = fieldErrors(
      await call("POST", "/admin/clubs", admin, clubBody({ openingHours: { ...weekHours, wed } })),
    );
    expect(errors.openingHours, JSON.stringify(errors)).toBeDefined();
  });

  it("rejects opening hours with a day missing", async () => {
    const { sun: _omit, ...sixDays } = weekHours;
    const errors = fieldErrors(
      await call("POST", "/admin/clubs", admin, clubBody({ openingHours: sixDays })),
    );
    expect(errors.openingHours).toBeDefined();
  });

  it("accepts 00:00-24:00, closed days and quarter hours", async () => {
    const hours = {
      ...weekHours,
      mon: { opens: "00:00", closes: "24:00" },
      tue: { opens: "06:45", closes: "21:15" },
      sat: null,
    };
    expect((await createClub({ openingHours: hours })).openingHours).toEqual(hours);
  });

  it("PATCH edits a subset, replaces the whole week of hours and bumps updatedAt", async () => {
    const club = await createClub();
    h.clock.advance(MINUTE);
    const allClosedButMon = {
      mon: { opens: "10:00", closes: "12:00" },
      tue: null,
      wed: null,
      thu: null,
      fri: null,
      sat: null,
      sun: null,
    };
    const updated = clubResponseSchema.parse(
      expectStatus(
        await call("PATCH", `/admin/clubs/${club.id}`, admin, {
          address: "New address",
          openingHours: allClosedButMon,
        }),
        200,
      ).json(),
    ).club;
    expect(updated).toMatchObject({
      name: club.name,
      address: "New address",
      timeZone: club.timeZone,
      currency: club.currency,
      openingHours: allClosedButMon,
    });
    expect(updated.createdAt).toBe(club.createdAt);
    expect(Date.parse(updated.updatedAt)).toBeGreaterThan(Date.parse(club.updatedAt));
  });

  it("PATCH validates like create and leaves the club unchanged on error", async () => {
    const club = await createClub();
    fieldErrors(await call("PATCH", `/admin/clubs/${club.id}`, admin, { timeZone: "BST" }));
    fieldErrors(
      await call("PATCH", `/admin/clubs/${club.id}`, admin, {
        name: "Valid new name",
        openingHours: { ...weekHours, mon: { opens: "20:00", closes: "08:00" } },
      }),
    );
    const detail = adminClubDetailResponseSchema.parse(
      (await call("GET", `/admin/clubs/${club.id}`, admin)).json(),
    );
    expect(detail.club.name).toBe(club.name);
    expect(detail.club.timeZone).toBe("Europe/London");
  });

  it("PATCH ignores attempts to change the id or timestamps", async () => {
    const club = await createClub();
    const response = await call("PATCH", `/admin/clubs/${club.id}`, admin, {
      id: randomUUID(),
      createdAt: "2000-01-01T00:00:00.000Z",
    });
    if (response.statusCode === 200) {
      const updated = clubResponseSchema.parse(response.json()).club;
      expect(updated.id).toBe(club.id);
      expect(updated.createdAt).toBe(club.createdAt);
    } else {
      expectApiError(response, 400, "validation_error");
    }
  });

  it("deactivating a club hides it publicly, keeps it for admins, and can be undone", async () => {
    const club = await createClub();
    await createCourt(club.id);
    expectStatus(await call("PATCH", `/admin/clubs/${club.id}`, admin, { active: false }), 200);
    expectApiError(await call("GET", `/clubs/${club.id}`), 404, "not_found");
    expectApiError(
      await call(
        "GET",
        `/clubs/${club.id}/blocks?from=2030-01-01T00:00:00Z&to=2030-01-02T00:00:00Z`,
      ),
      404,
      "not_found",
    );
    const detail = adminClubDetailResponseSchema.parse(
      expectStatus(await call("GET", `/admin/clubs/${club.id}`, admin), 200).json(),
    );
    expect(detail.club.active).toBe(false);
    expect(detail.courts).toHaveLength(1);
    expectStatus(await call("PATCH", `/admin/clubs/${club.id}`, admin, { active: true }), 200);
    expectStatus(await call("GET", `/clubs/${club.id}`), 200);
  });

  it("clubs cannot be deleted (no DELETE route)", async () => {
    const club = await createClub();
    expect([404, 405]).toContain(
      (await call("DELETE", `/admin/clubs/${club.id}`, admin)).statusCode,
    );
    expectStatus(await call("GET", `/admin/clubs/${club.id}`, admin), 200);
  });

  it.each(["not-a-uuid", randomUUID(), "00000000-0000-0000-0000-000000000000"])(
    "unknown or malformed club id %s is 404 not_found",
    async (id) => {
      expectApiError(await call("GET", `/admin/clubs/${id}`, admin), 404, "not_found");
      expectApiError(
        await call("PATCH", `/admin/clubs/${id}`, admin, { name: "x" }),
        404,
        "not_found",
      );
      expectApiError(await call("GET", `/clubs/${id}`), 404, "not_found");
    },
  );
});

// ---------------------------------------------------------------------------
// Courts
// ---------------------------------------------------------------------------

describe("courts", () => {
  it("adds indoor and outdoor courts, active by default, listed by name", async () => {
    const club = await createClub();
    const b = await createCourt(club.id, { name: "Court B", environment: "outdoor" });
    const a = await createCourt(club.id, { name: "Court A" });
    expect(a).toMatchObject({ clubId: club.id, environment: "indoor", active: true });
    expect(b.environment).toBe("outdoor");
    const detail = publicClubDetailResponseSchema.parse(
      expectStatus(await call("GET", `/clubs/${club.id}`), 200).json(),
    );
    expect(detail.courts.map((c) => c.name)).toEqual(["Court A", "Court B"]);
  });

  it("edits a court's name and environment", async () => {
    const club = await createClub();
    const court = await createCourt(club.id, { name: "Old" });
    const updated = courtResponseSchema.parse(
      expectStatus(
        await call("PATCH", `/admin/clubs/${club.id}/courts/${court.id}`, admin, {
          name: "New",
          environment: "outdoor",
        }),
        200,
      ).json(),
    ).court;
    expect(updated).toMatchObject({ id: court.id, name: "New", environment: "outdoor" });
  });

  it("court names are unique within a club ignoring case, but can repeat across clubs", async () => {
    const club = await createClub();
    const other = await createClub();
    await createCourt(club.id, { name: "Centre Court" });
    expectApiError(
      await call("POST", `/admin/clubs/${club.id}/courts`, admin, {
        name: " centre COURT ",
        environment: "indoor",
      }),
      409,
      "court_name_taken",
    );
    const second = await createCourt(club.id, { name: "Court 2" });
    expectApiError(
      await call("PATCH", `/admin/clubs/${club.id}/courts/${second.id}`, admin, {
        name: "CENTRE COURT",
      }),
      409,
      "court_name_taken",
    );
    await createCourt(other.id, { name: "Centre Court" });
  });

  it.each([
    ["missing environment", { name: "X" }, "environment"],
    ["unknown environment", { name: "X", environment: "covered" }, "environment"],
    ["blank name", { name: " ", environment: "indoor" }, "name"],
    ["name too long", { name: "c".repeat(41), environment: "indoor" }, "name"],
    ["non-boolean active", { name: "X", environment: "indoor", active: 0 }, "active"],
  ])("rejects a court with %s", async (_label, body, field) => {
    const club = await createClub();
    const errors = fieldErrors(await call("POST", `/admin/clubs/${club.id}/courts`, admin, body));
    expect(errors[field], JSON.stringify(errors)).toBeDefined();
  });

  it("deactivating a court hides it publicly but keeps it for admins; reactivating restores it", async () => {
    const club = await createClub();
    const court = await createCourt(club.id);
    const off = courtResponseSchema.parse(
      expectStatus(
        await call("PATCH", `/admin/clubs/${club.id}/courts/${court.id}`, admin, { active: false }),
        200,
      ).json(),
    ).court;
    expect(off.active).toBe(false);
    const pub = publicClubDetailResponseSchema.parse(
      (await call("GET", `/clubs/${club.id}`)).json(),
    );
    expect(pub.courts.some((c) => c.id === court.id)).toBe(false);
    const adm = adminClubDetailResponseSchema.parse(
      (await call("GET", `/admin/clubs/${club.id}`, admin)).json(),
    );
    expect(adm.courts.find((c) => c.id === court.id)?.active).toBe(false);
    expectStatus(
      await call("PATCH", `/admin/clubs/${club.id}/courts/${court.id}`, admin, { active: true }),
      200,
    );
    const again = publicClubDetailResponseSchema.parse(
      (await call("GET", `/clubs/${club.id}`)).json(),
    );
    expect(again.courts.some((c) => c.id === court.id)).toBe(true);
  });

  it("courts cannot be deleted (no DELETE route)", async () => {
    const club = await createClub();
    const court = await createCourt(club.id);
    const response = await call("DELETE", `/admin/clubs/${club.id}/courts/${court.id}`, admin);
    expect([404, 405]).toContain(response.statusCode);
    const detail = adminClubDetailResponseSchema.parse(
      (await call("GET", `/admin/clubs/${club.id}`, admin)).json(),
    );
    expect(detail.courts).toHaveLength(1);
  });

  it("a court of another club is 404 through this club's path", async () => {
    const club = await createClub();
    const other = await createClub();
    const foreign = await createCourt(other.id);
    expectApiError(
      await call("PATCH", `/admin/clubs/${club.id}/courts/${foreign.id}`, admin, { active: false }),
      404,
      "not_found",
    );
    const detail = adminClubDetailResponseSchema.parse(
      (await call("GET", `/admin/clubs/${other.id}`, admin)).json(),
    );
    expect(detail.courts[0]!.active).toBe(true);
    expectApiError(
      await call("PATCH", `/admin/clubs/${club.id}/courts/not-a-uuid`, admin, { active: false }),
      404,
      "not_found",
    );
  });

  it("adding a court to an unknown club is 404", async () => {
    expectApiError(
      await call("POST", `/admin/clubs/${randomUUID()}/courts`, admin, {
        name: "X",
        environment: "indoor",
      }),
      404,
      "not_found",
    );
  });
});

// ---------------------------------------------------------------------------
// Slot lengths and prices
// ---------------------------------------------------------------------------

describe("pricing", () => {
  it("PUT stores pricing and returns it normalised (sorted); public and admin detail show it", async () => {
    const club = await createClub();
    const saved = pricingResponseSchema.parse(
      expectStatus(await putPricing(club.id), 200).json(),
    ).pricing;
    expect(saved.slotLengthsMinutes).toEqual([60, 90]);
    expect(saved.standardPrices).toEqual([
      { minutes: 60, amountMinor: 3000 },
      { minutes: 90, amountMinor: 4200 },
    ]);
    expect(saved.bands[0]!.days).toEqual(["mon", "tue", "wed", "thu", "fri"]);
    expect(saved.bands[0]!.prices.map((p) => p.minutes)).toEqual([60, 90]);

    const pub = publicClubDetailResponseSchema.parse(
      (await call("GET", `/clubs/${club.id}`)).json(),
    );
    expect(pub.pricing).toEqual(saved);
    const adm = adminClubDetailResponseSchema.parse(
      (await call("GET", `/admin/clubs/${club.id}`, admin)).json(),
    );
    expect(adm.pricing).toEqual(saved);
    const row = adminClubListResponseSchema
      .parse((await call("GET", "/admin/clubs", admin)).json())
      .clubs.find((c) => c.id === club.id);
    expect(row?.hasPricing).toBe(true);
  });

  it("money is integer minor units in the raw JSON (no decimals, no strings)", async () => {
    const club = await createClub();
    const response = expectStatus(await putPricing(club.id), 200);
    expect(response.body).toContain('"amountMinor":3000');
    expect(response.body).not.toMatch(/"amountMinor":\s*("|\d+\.)/);
    const pub = await call("GET", `/clubs/${club.id}`);
    expect(pub.body).toContain('"amountMinor":4200');
    expect(pub.body).not.toMatch(/"amountMinor":\s*("|\d+\.)/);
  });

  it("PUT replaces the whole pricing; a second PUT without bands drops them", async () => {
    const club = await createClub();
    expectStatus(await putPricing(club.id), 200);
    const replaced = pricingResponseSchema.parse(
      expectStatus(
        await putPricing(club.id, {
          slotLengthsMinutes: [60],
          standardPrices: [{ minutes: 60, amountMinor: 2500 }],
        }),
        200,
      ).json(),
    ).pricing;
    expect(replaced).toEqual({
      slotLengthsMinutes: [60],
      standardPrices: [{ minutes: 60, amountMinor: 2500 }],
      bands: [],
    });
  });

  it("DELETE removes pricing (204, idempotent) and the club shows pricing null", async () => {
    const club = await createClub();
    expectStatus(await putPricing(club.id), 200);
    expectStatus(await call("DELETE", `/admin/clubs/${club.id}/pricing`, admin), 204);
    expectStatus(await call("DELETE", `/admin/clubs/${club.id}/pricing`, admin), 204);
    const pub = publicClubDetailResponseSchema.parse(
      (await call("GET", `/clubs/${club.id}`)).json(),
    );
    expect(pub.pricing).toBeNull();
  });

  it("a free (0) price is allowed", async () => {
    const club = await createClub();
    expectStatus(
      await putPricing(club.id, {
        slotLengthsMinutes: [60],
        standardPrices: [{ minutes: 60, amountMinor: 0 }],
      }),
      200,
    );
  });

  it.each([
    ["a negative price", -1],
    ["a decimal price", 30.5],
    ["a price as a string", "3000"],
    ["a price above the max", 10_000_001],
    ["an unsafe integer price", Number.MAX_SAFE_INTEGER + 2],
    ["a null price", null],
  ])("rejects %s", async (_label, amountMinor) => {
    const club = await createClub();
    const errors = fieldErrors(
      await putPricing(club.id, {
        slotLengthsMinutes: [60],
        standardPrices: [{ minutes: 60, amountMinor }],
      }),
    );
    expect(errors.standardPrices, JSON.stringify(errors)).toBeDefined();
    const pub = publicClubDetailResponseSchema.parse(
      (await call("GET", `/clubs/${club.id}`)).json(),
    );
    expect(pub.pricing).toBeNull();
  });

  it("rejects a negative peak price", async () => {
    const club = await createClub();
    const errors = fieldErrors(
      await putPricing(
        club.id,
        pricingWith({
          bands: [
            band({
              prices: [
                { minutes: 60, amountMinor: -100 },
                { minutes: 90, amountMinor: 100 },
              ],
            }),
          ],
        }),
      ),
    );
    expect(errors.bands).toBeDefined();
  });

  it.each([
    ["zero", [0]],
    ["negative", [-60]],
    ["below 30", [15]],
    ["above 240", [255]],
    ["not a multiple of 15", [61]],
    ["fractional", [60.5]],
    ["duplicated", [60, 60]],
    ["empty", []],
    ["more than 4", [30, 45, 60, 75, 90]],
  ])("rejects %s slot lengths", async (_label, slotLengthsMinutes) => {
    const club = await createClub();
    const errors = fieldErrors(
      await putPricing(club.id, {
        slotLengthsMinutes,
        standardPrices: slotLengthsMinutes.map((minutes) => ({ minutes, amountMinor: 1000 })),
      }),
    );
    expect(
      errors.slotLengthsMinutes ?? errors.standardPrices,
      JSON.stringify(errors),
    ).toBeDefined();
  });

  it.each([30, 45, 75, 240])("accepts a %i-minute slot length", async (minutes) => {
    const club = await createClub();
    expectStatus(
      await putPricing(club.id, {
        slotLengthsMinutes: [minutes],
        standardPrices: [{ minutes, amountMinor: 1000 }],
      }),
      200,
    );
  });

  it("rejects standard prices that do not cover exactly the slot lengths", async () => {
    const club = await createClub();
    for (const standardPrices of [
      [{ minutes: 60, amountMinor: 3000 }],
      [
        { minutes: 60, amountMinor: 3000 },
        { minutes: 90, amountMinor: 4200 },
        { minutes: 120, amountMinor: 5000 },
      ],
      [
        { minutes: 60, amountMinor: 3000 },
        { minutes: 60, amountMinor: 3100 },
      ],
    ]) {
      const errors = fieldErrors(
        await putPricing(club.id, { slotLengthsMinutes: [60, 90], standardPrices }),
      );
      expect(errors.standardPrices, JSON.stringify(errors)).toBeDefined();
    }
  });

  it("rejects a band missing a price for one slot length", async () => {
    const club = await createClub();
    const errors = fieldErrors(
      await putPricing(
        club.id,
        pricingWith({ bands: [band({ prices: [{ minutes: 60, amountMinor: 4000 }] })] }),
      ),
    );
    expect(errors.bands).toBeDefined();
  });

  it.each([
    ["the same window", { starts: "17:00", ends: "19:00" }],
    ["a partial overlap", { starts: "18:00", ends: "20:00" }],
    ["one inside the other", { starts: "17:30", ends: "18:00" }],
    ["one containing the other", { starts: "16:00", ends: "21:00" }],
  ])("rejects bands overlapping with %s on a shared day", async (_label, times) => {
    const club = await createClub();
    const errors = fieldErrors(
      await putPricing(
        club.id,
        pricingWith({
          bands: [
            band({ label: "Peak", days: ["mon", "tue"] }),
            band({ label: "Evening", days: ["tue", "wed"], ...times }),
          ],
        }),
      ),
    );
    expect(errors.bands, JSON.stringify(errors)).toBeDefined();
    expect(JSON.stringify(errors.bands)).toMatch(/overlap/i);
  });

  it("accepts touching bands and the same hours on different days", async () => {
    const club = await createClub();
    expectStatus(
      await putPricing(
        club.id,
        pricingWith({
          bands: [
            band({ label: "Early peak", days: ["mon"], starts: "17:00", ends: "19:00" }),
            band({ label: "Late peak", days: ["mon"], starts: "19:00", ends: "22:00" }),
            band({ label: "Weekend", days: ["sat", "sun"], starts: "17:00", ends: "22:00" }),
          ],
        }),
      ),
      200,
    );
  });

  it.each([
    ["ends before it starts", { starts: "19:00", ends: "17:00" }],
    ["ends when it starts", { starts: "17:00", ends: "17:00" }],
    ["off-grid time", { starts: "17:05", ends: "19:00" }],
    ["no days", { days: [] }],
    ["unknown day", { days: ["funday"] }],
    ["duplicate day", { days: ["mon", "mon"] }],
    ["blank label", { label: " " }],
  ])("rejects a band that has %s", async (_label, overrides) => {
    const club = await createClub();
    const errors = fieldErrors(
      await putPricing(club.id, pricingWith({ bands: [band(overrides)] })),
    );
    expect(errors.bands, JSON.stringify(errors)).toBeDefined();
  });

  it("rejects more than 20 bands", async () => {
    const club = await createClub();
    const bands = Array.from({ length: 21 }, (_, i) =>
      band({
        label: `B${i}`,
        days: ["mon"],
        starts: `${String(i).padStart(2, "0")}:00`,
        ends: `${String(i).padStart(2, "0")}:30`,
      }),
    );
    fieldErrors(await putPricing(club.id, pricingWith({ bands })));
  });

  it("an invalid PUT leaves the existing pricing in place", async () => {
    const club = await createClub();
    const saved = pricingResponseSchema.parse((await putPricing(club.id)).json()).pricing;
    fieldErrors(await putPricing(club.id, pricingWith({ slotLengthsMinutes: [] })));
    const pub = publicClubDetailResponseSchema.parse(
      (await call("GET", `/clubs/${club.id}`)).json(),
    );
    expect(pub.pricing).toEqual(saved);
  });

  it("currency is locked while pricing exists, and unlocked after DELETE pricing", async () => {
    const club = await createClub();
    expectStatus(await putPricing(club.id), 200);
    expectApiError(
      await call("PATCH", `/admin/clubs/${club.id}`, admin, { currency: "EUR" }),
      409,
      "currency_locked",
    );
    // Same currency (any case) is not a change.
    expectStatus(await call("PATCH", `/admin/clubs/${club.id}`, admin, { currency: "gbp" }), 200);
    expectStatus(await call("DELETE", `/admin/clubs/${club.id}/pricing`, admin), 204);
    const updated = clubResponseSchema.parse(
      expectStatus(
        await call("PATCH", `/admin/clubs/${club.id}`, admin, { currency: "EUR" }),
        200,
      ).json(),
    ).club;
    expect(updated.currency).toBe("EUR");
  });

  it("pricing for an unknown club is 404", async () => {
    expectApiError(await putPricing(randomUUID()), 404, "not_found");
    expectApiError(
      await call("DELETE", `/admin/clubs/${randomUUID()}/pricing`, admin),
      404,
      "not_found",
    );
  });
});

// ---------------------------------------------------------------------------
// Court blocks
// ---------------------------------------------------------------------------

describe("court blocks", () => {
  async function setup(timeZone = "Europe/London") {
    const club = await createClub({ timeZone });
    const courtB = await createCourt(club.id, { name: "B court" });
    const courtA = await createCourt(club.id, { name: "A court" });
    return { club, courtA, courtB };
  }

  function blocksOf(response: LightMyRequestResponse) {
    return courtBlockListResponseSchema.parse(response.json()).blocks;
  }

  it("blocks several courts at once, one block each, ordered by court name", async () => {
    const { club, courtA, courtB } = await setup();
    const blocks = blocksOf(
      expectStatus(
        await createBlocks(club.id, {
          courtIds: [courtB.id, courtA.id],
          startsLocal: "2030-12-12T09:00",
          endsLocal: "2030-12-12T14:00",
          reason: "event",
          note: "  Christmas tournament  ",
        }),
        201,
      ),
    );
    expect(blocks.map((b) => b.courtId)).toEqual([courtA.id, courtB.id]);
    for (const b of blocks) {
      expect(b).toMatchObject({
        clubId: club.id,
        reason: "event",
        note: "Christmas tournament",
        startsAt: "2030-12-12T09:00:00.000Z",
        endsAt: "2030-12-12T14:00:00.000Z",
        startsLocal: "2030-12-12T09:00",
        endsLocal: "2030-12-12T14:00",
        cancelledAt: null,
      });
    }
  });

  it.each([
    [
      "Europe/London in summer (BST)",
      "Europe/London",
      "2030-07-01T09:00",
      "2030-07-01T08:00:00.000Z",
    ],
    ["Asia/Jakarta", "Asia/Jakarta", "2030-07-01T09:00", "2030-07-01T02:00:00.000Z"],
    [
      "America/New_York in winter",
      "America/New_York",
      "2030-01-15T09:00",
      "2030-01-15T14:00:00.000Z",
    ],
    ["Asia/Kolkata (+05:30)", "Asia/Kolkata", "2030-01-15T09:00", "2030-01-15T03:30:00.000Z"],
  ])("converts local block times with the club time zone: %s", async (_l, tz, local, utc) => {
    const { club, courtA } = await setup(tz);
    const [block] = blocksOf(
      expectStatus(
        await createBlocks(club.id, {
          courtIds: [courtA.id],
          startsLocal: local,
          endsLocal: local.replace("T09:00", "T10:00"),
        }),
        201,
      ),
    );
    expect(block!.startsAt).toBe(utc);
    expect(block!.startsLocal).toBe(local);
  });

  it("rejects a start time skipped when the clocks go forward (London, 30 Mar 2031 01:30)", async () => {
    const { club, courtA } = await setup();
    const errors = fieldErrors(
      await createBlocks(club.id, {
        courtIds: [courtA.id],
        startsLocal: "2031-03-30T01:30",
        endsLocal: "2031-03-30T03:00",
      }),
    );
    expect(errors.startsLocal).toBeDefined();
  });

  it("rejects an end time skipped when the clocks go forward", async () => {
    const { club, courtA } = await setup();
    const errors = fieldErrors(
      await createBlocks(club.id, {
        courtIds: [courtA.id],
        startsLocal: "2031-03-30T00:00",
        endsLocal: "2031-03-30T01:15",
      }),
    );
    expect(errors.endsLocal).toBeDefined();
  });

  it("a block across the spring-forward night is one hour shorter in real time", async () => {
    const { club, courtA } = await setup();
    const [block] = blocksOf(
      expectStatus(
        await createBlocks(club.id, {
          courtIds: [courtA.id],
          startsLocal: "2031-03-30T00:00",
          endsLocal: "2031-03-30T03:00",
        }),
        201,
      ),
    );
    expect(block!.startsAt).toBe("2031-03-30T00:00:00.000Z");
    expect(block!.endsAt).toBe("2031-03-30T02:00:00.000Z");
  });

  it("uses the earlier instant in the repeated hour when the clocks go back (26 Oct 2031)", async () => {
    const { club, courtA } = await setup();
    const [block] = blocksOf(
      expectStatus(
        await createBlocks(club.id, {
          courtIds: [courtA.id],
          startsLocal: "2031-10-26T01:15",
          endsLocal: "2031-10-26T01:45",
        }),
        201,
      ),
    );
    // 01:15 BST = 00:15Z (the earlier of 00:15Z and 01:15Z).
    expect(block!.startsAt).toBe("2031-10-26T00:15:00.000Z");
    expect(block!.endsAt).toBe("2031-10-26T00:45:00.000Z");
    expect(block!.startsLocal).toBe("2031-10-26T01:15");
  });

  it("a block across the fall-back night is one hour longer in real time", async () => {
    const { club, courtA } = await setup();
    const [block] = blocksOf(
      expectStatus(
        await createBlocks(club.id, {
          courtIds: [courtA.id],
          startsLocal: "2031-10-26T00:00",
          endsLocal: "2031-10-26T03:00",
        }),
        201,
      ),
    );
    expect(Date.parse(block!.endsAt) - Date.parse(block!.startsAt)).toBe(4 * 60 * MINUTE);
  });

  it.each([
    ["ends before it starts", "2030-12-12T14:00", "2030-12-12T09:00"],
    ["ends when it starts", "2030-12-12T09:00", "2030-12-12T09:00"],
    ["ends a day before", "2030-12-13T09:00", "2030-12-12T10:00"],
  ])("rejects a block that %s", async (_label, startsLocal, endsLocal) => {
    const { club, courtA } = await setup();
    const errors = fieldErrors(
      await createBlocks(club.id, { courtIds: [courtA.id], startsLocal, endsLocal }),
    );
    expect(errors.endsLocal).toBeDefined();
  });

  it.each([
    ["a space separator", "2030-12-12 09:00"],
    ["a UTC suffix", "2030-12-12T09:00Z"],
    ["an offset", "2030-12-12T09:00+01:00"],
    ["seconds", "2030-12-12T09:00:00"],
    ["an impossible date", "2030-02-30T09:00"],
    ["hour 24", "2030-12-12T24:00"],
    ["a date only", "2030-12-12"],
    ["empty", ""],
  ])("rejects a start time with %s", async (_label, startsLocal) => {
    const { club, courtA } = await setup();
    const errors = fieldErrors(
      await createBlocks(club.id, {
        courtIds: [courtA.id],
        startsLocal,
        endsLocal: "2030-12-13T10:00",
      }),
    );
    expect(errors.startsLocal, JSON.stringify(errors)).toBeDefined();
  });

  it.each([
    ["no courts", { courtIds: [] }],
    ["a malformed id", { courtIds: ["nope"] }],
    ["the same court twice", "dup"],
    ["an unknown court", "unknown"],
    ["a court of another club", "foreign"],
    ["a valid court plus a court of another club", "mixed"],
  ])("rejects %s (courtIds) and creates nothing", async (_label, variant) => {
    const { club, courtA } = await setup();
    const other = await createClub();
    const foreign = await createCourt(other.id);
    const courtIds =
      variant === "dup"
        ? [courtA.id, courtA.id]
        : variant === "unknown"
          ? [randomUUID()]
          : variant === "foreign"
            ? [foreign.id]
            : variant === "mixed"
              ? [courtA.id, foreign.id]
              : (variant as { courtIds: string[] }).courtIds;
    const errors = fieldErrors(
      await createBlocks(club.id, {
        courtIds,
        startsLocal: "2030-12-12T09:00",
        endsLocal: "2030-12-12T10:00",
      }),
    );
    expect(errors.courtIds, JSON.stringify(errors)).toBeDefined();
    for (const id of [club.id, other.id]) {
      const list = blocksOf(
        await call("GET", `/admin/clubs/${id}/blocks?includeCancelled=true`, admin),
      );
      expect(list).toHaveLength(0);
    }
  });

  it.each([
    ["unknown reason", { reason: "party" }, "reason"],
    ["note too long", { note: "n".repeat(201) }, "note"],
  ])("rejects a block with %s", async (_label, extra, field) => {
    const { club, courtA } = await setup();
    const errors = fieldErrors(
      await createBlocks(club.id, {
        courtIds: [courtA.id],
        startsLocal: "2030-12-12T09:00",
        endsLocal: "2030-12-12T10:00",
        ...extra,
      }),
    );
    expect(errors[field]).toBeDefined();
  });

  it("allows overlapping blocks and blocks on inactive courts", async () => {
    const { club, courtA } = await setup();
    const body = {
      courtIds: [courtA.id],
      startsLocal: "2030-12-12T09:00",
      endsLocal: "2030-12-12T12:00",
    };
    expectStatus(await createBlocks(club.id, body), 201);
    expectStatus(await createBlocks(club.id, { ...body, startsLocal: "2030-12-12T10:00" }), 201);
    await call("PATCH", `/admin/clubs/${club.id}/courts/${courtA.id}`, admin, { active: false });
    expectStatus(await createBlocks(club.id, body), 201);
  });

  it("cancelling a block keeps it (cancelledAt), hides it by default, and is idempotent", async () => {
    const { club, courtA } = await setup();
    const [block] = blocksOf(
      expectStatus(
        await createBlocks(club.id, {
          courtIds: [courtA.id],
          startsLocal: "2030-12-12T09:00",
          endsLocal: "2030-12-12T10:00",
        }),
        201,
      ),
    );
    expectStatus(await call("DELETE", `/admin/clubs/${club.id}/blocks/${block!.id}`, admin), 204);
    expectStatus(await call("DELETE", `/admin/clubs/${club.id}/blocks/${block!.id}`, admin), 204);

    expect(blocksOf(await call("GET", `/admin/clubs/${club.id}/blocks`, admin))).toHaveLength(0);
    const withCancelled = blocksOf(
      await call("GET", `/admin/clubs/${club.id}/blocks?includeCancelled=true`, admin),
    );
    expect(withCancelled).toHaveLength(1);
    expect(withCancelled[0]!.cancelledAt).not.toBeNull();

    const pub = publicCourtBlockListResponseSchema.parse(
      (
        await call(
          "GET",
          `/clubs/${club.id}/blocks?from=2030-12-12T00:00:00Z&to=2030-12-13T00:00:00Z`,
        )
      ).json(),
    );
    expect(pub.blocks).toHaveLength(0);

    const rows = await connection.pool.query("select * from court_blocks where id = $1", [
      block!.id,
    ]);
    expect(rows.rowCount).toBe(1);
  });

  it("a block of another club, an unknown block and a malformed id are 404", async () => {
    const { club, courtA } = await setup();
    const other = await setup();
    const [foreign] = blocksOf(
      await createBlocks(other.club.id, {
        courtIds: [other.courtA.id],
        startsLocal: "2030-12-12T09:00",
        endsLocal: "2030-12-12T10:00",
      }),
    );
    expectApiError(
      await call("DELETE", `/admin/clubs/${club.id}/blocks/${foreign!.id}`, admin),
      404,
      "not_found",
    );
    const stillThere = blocksOf(await call("GET", `/admin/clubs/${other.club.id}/blocks`, admin));
    expect(stillThere[0]!.cancelledAt).toBeNull();
    expectApiError(
      await call("DELETE", `/admin/clubs/${club.id}/blocks/${randomUUID()}`, admin),
      404,
      "not_found",
    );
    expectApiError(
      await call("DELETE", `/admin/clubs/${club.id}/blocks/nope`, admin),
      404,
      "not_found",
    );
    void courtA;
  });

  it("admin list: from defaults to now (past hidden), filters by court and range", async () => {
    const { club, courtA, courtB } = await setup();
    const past = h.clock.now();
    past.setUTCDate(past.getUTCDate() - 3);
    const pastDay = past.toISOString().slice(0, 10);
    expectStatus(
      await createBlocks(club.id, {
        courtIds: [courtA.id],
        startsLocal: `${pastDay}T09:00`,
        endsLocal: `${pastDay}T10:00`,
      }),
      201,
    );
    expectStatus(
      await createBlocks(club.id, {
        courtIds: [courtA.id, courtB.id],
        startsLocal: "2030-12-12T09:00",
        endsLocal: "2030-12-12T10:00",
      }),
      201,
    );
    expect(blocksOf(await call("GET", `/admin/clubs/${club.id}/blocks`, admin))).toHaveLength(2);
    expect(
      blocksOf(
        await call("GET", `/admin/clubs/${club.id}/blocks?from=2000-01-01T00:00:00Z`, admin),
      ),
    ).toHaveLength(3);
    expect(
      blocksOf(await call("GET", `/admin/clubs/${club.id}/blocks?courtId=${courtB.id}`, admin)),
    ).toHaveLength(1);
    // [from, to) overlap: a range ending exactly at the block's start excludes it.
    expect(
      blocksOf(
        await call(
          "GET",
          `/admin/clubs/${club.id}/blocks?from=2030-12-12T08:00:00Z&to=2030-12-12T09:00:00Z`,
          admin,
        ),
      ),
    ).toHaveLength(0);
    expect(
      blocksOf(
        await call(
          "GET",
          `/admin/clubs/${club.id}/blocks?from=2030-12-12T09:59:00Z&to=2030-12-12T11:00:00Z`,
          admin,
        ),
      ),
    ).toHaveLength(2);
  });

  it.each(["from=yesterday", "to=2030-13-01T00:00:00Z", "courtId=nope", "includeCancelled=yes"])(
    "admin list rejects ?%s with 400",
    async (query) => {
      const { club } = await setup();
      fieldErrors(await call("GET", `/admin/clubs/${club.id}/blocks?${query}`, admin));
    },
  );

  it("public blocks: only courtId/startsAt/endsAt, active courts only, non-cancelled", async () => {
    const { club, courtA, courtB } = await setup();
    expectStatus(
      await createBlocks(club.id, {
        courtIds: [courtA.id, courtB.id],
        startsLocal: "2030-12-12T09:00",
        endsLocal: "2030-12-12T10:00",
        reason: "other",
        note: "secret staff note",
      }),
      201,
    );
    await call("PATCH", `/admin/clubs/${club.id}/courts/${courtB.id}`, admin, { active: false });
    const response = expectStatus(
      await call(
        "GET",
        `/clubs/${club.id}/blocks?from=2030-12-12T00:00:00Z&to=2030-12-13T00:00:00Z`,
      ),
      200,
    );
    expect(response.body).not.toContain("secret");
    const body = response.json() as { blocks: Record<string, unknown>[] };
    expect(body.blocks).toHaveLength(1);
    expect(Object.keys(body.blocks[0]!).sort()).toEqual(["courtId", "endsAt", "startsAt"]);
    expect(body.blocks[0]!.courtId).toBe(courtA.id);
  });

  it.each([
    ["missing both", ""],
    ["missing to", "from=2030-01-01T00:00:00Z"],
    ["to before from", "from=2030-01-02T00:00:00Z&to=2030-01-01T00:00:00Z"],
    ["to equal to from", "from=2030-01-01T00:00:00Z&to=2030-01-01T00:00:00Z"],
    ["more than 62 days", "from=2030-01-01T00:00:00Z&to=2030-03-04T00:00:01Z"],
    ["no offset", "from=2030-01-01T00:00:00&to=2030-01-02T00:00:00"],
  ])("public blocks reject %s with 400", async (_label, query) => {
    const { club } = await setup();
    fieldErrors(await call("GET", `/clubs/${club.id}/blocks?${query}`));
  });

  it("public blocks accept exactly 62 days and offsets", async () => {
    const { club } = await setup();
    expectStatus(
      await call(
        "GET",
        `/clubs/${club.id}/blocks?from=2030-01-01T00:00:00Z&to=2030-03-04T00:00:00Z`,
      ),
      200,
    );
    expectStatus(
      await call(
        "GET",
        `/clubs/${club.id}/blocks?from=2030-01-01T00:00:00%2B07:00&to=2030-01-02T00:00:00-05:00`,
      ),
      200,
    );
  });
});

// ---------------------------------------------------------------------------
// First admin
// ---------------------------------------------------------------------------

describe("promoteToAdmin (first-admin script)", () => {
  it("promotes a verified member; running it again is harmless", async () => {
    const m = await activeMember(h);
    await promoteToAdmin(connection.db, m.email);
    await promoteToAdmin(connection.db, m.email);
    const token = (await logIn(h, m.email)).accessToken;
    expectStatus(await call("GET", "/admin/clubs", token), 200);
    const me = await call("GET", "/auth/me", token);
    expect((me.json() as { user: { role: string } }).user.role).toBe("admin");
  });

  it("finds the account ignoring email case", async () => {
    const m = await activeMember(h);
    await promoteToAdmin(connection.db, m.email.toUpperCase()).catch(() => undefined);
    const role = await connection.pool.query<{ role: string }>(
      "select role from users where id = $1",
      [m.session.user.id],
    );
    expect(role.rows[0]!.role).toBe("admin");
  });

  it("refuses an unknown email", async () => {
    await expect(
      (async () => {
        const result = (await promoteToAdmin(connection.db, uniqueEmail("nobody"))) as unknown;
        if (result && typeof result === "object" && "ok" in result && !result.ok) {
          throw new Error("refused");
        }
      })(),
    ).rejects.toThrow();
  });

  it("refuses an unverified account and leaves it a member", async () => {
    const email = uniqueEmail();
    await signUp(h, email);
    await (async () => {
      try {
        await promoteToAdmin(connection.db, email);
      } catch {
        /* refused by throwing */
      }
    })();
    const role = await connection.pool.query<{ role: string }>(
      "select role from users where lower(email) = lower($1)",
      [email],
    );
    expect(role.rows[0]!.role).toBe("member");
  });
});
