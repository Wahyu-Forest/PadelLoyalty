/**
 * #3 Under-18 / parental consent flow, against the real test database.
 * Contract: docs/api/consent.md.
 */
import {
  apiErrorResponseSchema,
  consentDecisionResponseSchema,
  consentReviewResponseSchema,
  consentStatusResponseSchema,
  verifyEmailResponseSchema,
  type ApiErrorCode,
} from "@padelloyalty/shared";
import { eq } from "drizzle-orm";
import type { LightMyRequestResponse } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { requireActiveAccount } from "../src/auth/routes.js";
import type { DatabaseConnection } from "../src/db/client.js";
import { guardianConsentRequests, users } from "../src/db/schema.js";
import { tokenFromLink } from "../src/email/mailer.js";
import {
  ADULT_DOB,
  APP_URL,
  PASSWORD,
  buildAuthApp,
  connectTestDatabase,
  resetAuthTables,
  type TestApp,
} from "./support/auth-app.js";

const DAY = 24 * 60 * 60_000;
/** Test "today". Tests that need another date set the clock themselves. */
const NOW = new Date("2026-11-24T12:00:00.000Z");
const KID = "kid@example.com";
const MUM = "mum@example.com";
const DAD = "dad@example.com";
const KID_DOB = "2012-05-01"; // 14 on NOW

let connection: DatabaseConnection;
let t: TestApp;

beforeAll(async () => {
  connection = await connectTestDatabase();
});
afterAll(async () => {
  await connection?.pool.end();
});
beforeEach(async () => {
  await resetAuthTables(connection);
  t = await buildAuthApp(connection);
  t.clock.current = new Date(NOW);
});
afterEach(async () => {
  await t.app.close();
});

function expectError(response: LightMyRequestResponse, status: number, code: ApiErrorCode) {
  expect(response.statusCode, response.body).toBe(status);
  const body = apiErrorResponseSchema.parse(response.json());
  expect(body.error.code).toBe(code);
  return body.error;
}

async function userRow(email: string) {
  const [row] = await connection.db.select().from(users).where(eq(users.email, email));
  return row;
}

async function consentRows(email: string) {
  const user = await userRow(email);
  if (!user) return [];
  return connection.db
    .select()
    .from(guardianConsentRequests)
    .where(eq(guardianConsentRequests.userId, user.id))
    .orderBy(guardianConsentRequests.requestedAt);
}

const get = (url: string, accessToken?: string) =>
  t.app.inject({
    method: "GET",
    url,
    headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {},
  });

const consentStatus = async (accessToken: string) => {
  const response = await get("/auth/consent", accessToken);
  expect(response.statusCode, response.body).toBe(200);
  return consentStatusResponseSchema.parse(response.json());
};

const requestConsent = (accessToken: string, body: object = {}) =>
  t.post("/auth/consent/request", body, { authorization: `Bearer ${accessToken}` });

const guardianToken = (guardian = MUM) => t.tokenFor(guardian, "guardian_consent");

const confirm = (token: string) =>
  t.post("/auth/consent/decision", { token, decision: "confirm", isParentOrGuardian: true });
const decline = (token: string) => t.post("/auth/consent/decision", { token, decision: "decline" });

async function signUpMinor(email = KID, guardianEmail = MUM, dateOfBirth = KID_DOB) {
  const response = await t.post("/auth/signup", {
    email,
    password: PASSWORD,
    dateOfBirth,
    guardianEmail,
  });
  expect(response.statusCode, response.body).toBe(202);
}

async function verify(email = KID) {
  const response = await t.post("/auth/verify-email", { token: t.tokenFor(email, "verify_email") });
  expect(response.statusCode, response.body).toBe(200);
  return verifyEmailResponseSchema.parse(response.json());
}

async function logIn(email = KID) {
  const response = await t.post("/auth/login", { email, password: PASSWORD });
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as { accessToken: string; user: { status: string } };
}

/** A verified under-18 member waiting for consent, logged in. */
async function pendingMinor(email = KID, guardianEmail = MUM) {
  await signUpMinor(email, guardianEmail);
  await verify(email);
  return logIn(email);
}

describe("AC: date of birth is captured at sign-up", () => {
  it("stores the date of birth for adults and ignores an adult's guardian email", async () => {
    const response = await t.post("/auth/signup", {
      email: "ana@example.com",
      password: PASSWORD,
      dateOfBirth: "1990-04-15",
      guardianEmail: MUM,
    });
    expect(response.statusCode).toBe(202);
    expect(await userRow("ana@example.com")).toMatchObject({
      dateOfBirth: "1990-04-15",
      guardianEmail: null,
    });
  });

  it("requires a date of birth", async () => {
    const error = expectError(
      await t.app.inject({
        method: "POST",
        url: "/auth/signup",
        payload: { email: "ana@example.com", password: PASSWORD },
      }),
      400,
      "validation_error",
    );
    expect(error.fieldErrors?.dateOfBirth).toBeDefined();
    expect(await userRow("ana@example.com")).toBeUndefined();
  });

  it.each([
    ["29 February in a non-leap year", "2011-02-29"],
    ["31 April", "2011-04-31"],
    ["month 13", "2011-13-01"],
    ["a wrong format", "01/05/2011"],
    ["a year before 1900", "1899-12-31"],
    ["tomorrow", "2026-11-25"],
    ["a far future date", "2100-01-01"],
  ])("rejects %s", async (_label, dateOfBirth) => {
    const error = expectError(
      await t.post("/auth/signup", {
        email: "ana@example.com",
        password: PASSWORD,
        dateOfBirth,
        guardianEmail: MUM,
      }),
      400,
      "validation_error",
    );
    expect(error.fieldErrors?.dateOfBirth).toBeDefined();
    expect(await userRow("ana@example.com")).toBeUndefined();
  });
});

describe("AC: members under 18 must enter a parent/guardian email", () => {
  it("rejects an under-18 sign-up without a guardian email", async () => {
    const error = expectError(
      await t.post("/auth/signup", { email: KID, password: PASSWORD, dateOfBirth: KID_DOB }),
      400,
      "validation_error",
    );
    expect(error.fieldErrors?.guardianEmail).toBeDefined();
  });

  it("rejects a guardian email equal to the member's own (after normalising)", async () => {
    const error = expectError(
      await t.post("/auth/signup", {
        email: KID,
        password: PASSWORD,
        dateOfBirth: KID_DOB,
        guardianEmail: " KID@Example.com ",
      }),
      400,
      "validation_error",
    );
    expect(error.fieldErrors?.guardianEmail).toBeDefined();
  });

  it("uses 18 as the threshold: the day before the 18th birthday needs a guardian, the day itself not", async () => {
    // NOW is 2026-11-24.
    const dayBefore = await t.post("/auth/signup", {
      email: "a@example.com",
      password: PASSWORD,
      dateOfBirth: "2008-11-25",
    });
    expectError(dayBefore, 400, "validation_error");
    const birthday = await t.post("/auth/signup", {
      email: "b@example.com",
      password: PASSWORD,
      dateOfBirth: "2008-11-24",
    });
    expect(birthday.statusCode).toBe(202);
  });

  it("treats a 29 February birthday as reached on 1 March in a non-leap year", async () => {
    t.clock.current = new Date("2026-02-28T12:00:00Z");
    expectError(
      await t.post("/auth/signup", {
        email: "leap@example.com",
        password: PASSWORD,
        dateOfBirth: "2008-02-29",
      }),
      400,
      "validation_error",
    );
    t.clock.current = new Date("2026-03-01T12:00:00Z");
    expect(
      (
        await t.post("/auth/signup", {
          email: "leap@example.com",
          password: PASSWORD,
          dateOfBirth: "2008-02-29",
        })
      ).statusCode,
    ).toBe(202);
  });

  it("stores the guardian email but emails nobody but the member until the member verifies", async () => {
    await signUpMinor();
    expect(await userRow(KID)).toMatchObject({
      dateOfBirth: KID_DOB,
      guardianEmail: MUM,
      status: "pending_verification",
    });
    expect(t.mailer.messages.map((m) => m.to)).toEqual([KID]);
    expect(await consentRows(KID)).toHaveLength(0);
  });
});

describe("AC: the guardian gets a consent link (single-use, expiring) and can confirm or decline", () => {
  it("verifying an under-18 member's email makes the account pending_consent and emails the guardian", async () => {
    await signUpMinor();
    const verified = await verify();
    expect(verified.accountStatus).toBe("pending_consent");
    expect(verified.message).toMatch(/guardian/i);
    expect((await userRow(KID))?.status).toBe("pending_consent");

    const email = t.mailer.lastTo(MUM, "guardian_consent");
    expect(email?.link).toMatch(new RegExp(`^${APP_URL}/guardian-consent/#token=plc_`));
    expect(email?.text).toContain(email?.link);
    expect(email?.text).toContain(KID);
    expect(email?.text).toMatch(/7 days/);
    expect(email?.text).toContain("[PLACEHOLDER: Soul Padel Safeguarding Policy");
  });

  it("an adult's verification makes the account active and emails no guardian", async () => {
    const login = await t.signUpVerified("ana@example.com");
    expect(login.user.status).toBe("active");
    expect(t.mailer.messages.some((m) => m.type === "guardian_consent")).toBe(false);
  });

  it("review shows the request without using up the link", async () => {
    await pendingMinor();
    const token = guardianToken();
    for (let i = 0; i < 2; i++) {
      const response = await t.post("/auth/consent/review", { token });
      expect(response.statusCode, response.body).toBe(200);
      expect(consentReviewResponseSchema.parse(response.json())).toEqual({
        memberEmail: KID,
        memberDateOfBirth: KID_DOB,
        guardianEmail: MUM,
        expiresAt: new Date(NOW.getTime() + 7 * DAY).toISOString(),
      });
    }
  });

  it("confirm activates the account; the link then stops working", async () => {
    const { accessToken } = await pendingMinor();
    const token = guardianToken();

    const response = await confirm(token);
    expect(response.statusCode, response.body).toBe(200);
    expect(consentDecisionResponseSchema.parse(response.json()).decision).toBe("confirm");

    expect((await userRow(KID))?.status).toBe("active");
    const me = await t.me(accessToken);
    expect(me.json().user.status).toBe("active");
    expect(await consentStatus(accessToken)).toMatchObject({
      state: "granted",
      guardianEmail: MUM,
      decidedAt: NOW.toISOString(),
    });

    expectError(await confirm(token), 400, "invalid_token");
    expectError(await decline(token), 400, "invalid_token");
    expectError(await t.post("/auth/consent/review", { token }), 400, "invalid_token");
  });

  it("confirm requires isParentOrGuardian: true", async () => {
    await pendingMinor();
    const token = guardianToken();
    for (const body of [
      { token, decision: "confirm" },
      { token, decision: "confirm", isParentOrGuardian: false },
    ]) {
      expectError(await t.post("/auth/consent/decision", body), 400, "validation_error");
    }
    expect((await userRow(KID))?.status).toBe("pending_consent");
    expect((await confirm(token)).statusCode).toBe(200);
  });

  it("decline keeps the account pending and tells the member", async () => {
    const { accessToken } = await pendingMinor();
    const response = await decline(guardianToken());
    expect(response.statusCode).toBe(200);
    expect(consentDecisionResponseSchema.parse(response.json()).decision).toBe("decline");

    expect((await userRow(KID))?.status).toBe("pending_consent");
    expect(await consentStatus(accessToken)).toMatchObject({
      state: "declined",
      guardianEmail: MUM,
      decidedAt: NOW.toISOString(),
    });
  });

  it("the link expires after 7 days", async () => {
    await pendingMinor();
    const token = guardianToken();
    t.clock.advance(7 * DAY);
    const { accessToken } = await logIn();
    expectError(await t.post("/auth/consent/review", { token }), 400, "invalid_token");
    expectError(await confirm(token), 400, "invalid_token");
    expect((await consentStatus(accessToken)).state).toBe("expired");
    expect((await userRow(KID))?.status).toBe("pending_consent");
  });

  it("unknown tokens give the same invalid_token error", async () => {
    expectError(await t.post("/auth/consent/review", { token: "plc_nope" }), 400, "invalid_token");
    expectError(await confirm("plc_nope"), 400, "invalid_token");
  });

  it("of two simultaneous decisions on one link, exactly one wins", async () => {
    await pendingMinor();
    const token = guardianToken();
    const results = await Promise.all([confirm(token), decline(token), confirm(token)]);
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    const rows = await consentRows(KID);
    expect(rows.filter((r) => r.status === "confirmed" || r.status === "declined")).toHaveLength(1);
  });

  it("an unverified under-18 who verifies by resetting their password is moved to pending_consent too", async () => {
    await signUpMinor();
    await t.post("/auth/password-reset/request", { email: KID });
    const reset = await t.post("/auth/password-reset/confirm", {
      token: t.tokenFor(KID, "password_reset"),
      password: "another long password",
    });
    expect(reset.statusCode).toBe(200);
    expect((await userRow(KID))?.status).toBe("pending_consent");
    expect(t.mailer.lastTo(MUM, "guardian_consent")).toBeDefined();
  });
});

describe("AC: until consent is given the account is pending; the member is told why and can resend", () => {
  it("a pending member can log in and sees the pending request", async () => {
    const login = await pendingMinor();
    expect(login.user.status).toBe("pending_consent");
    expect(await consentStatus(login.accessToken)).toEqual({
      state: "pending",
      guardianEmail: MUM,
      requestedAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 7 * DAY).toISOString(),
      decidedAt: null,
    });
  });

  it("before verifying, the state is awaiting_member_verification", async () => {
    await signUpMinor();
    const { accessToken } = await logIn();
    expect(await consentStatus(accessToken)).toMatchObject({
      state: "awaiting_member_verification",
      guardianEmail: MUM,
    });
  });

  it("resend emails a new link and the old link stops working", async () => {
    const { accessToken } = await pendingMinor();
    const first = guardianToken();
    t.clock.advance(60_000);

    const response = await requestConsent(accessToken);
    expect(response.statusCode, response.body).toBe(200);
    expect(consentStatusResponseSchema.parse(response.json())).toMatchObject({
      state: "pending",
      guardianEmail: MUM,
      requestedAt: t.clock.now().toISOString(),
    });
    const second = guardianToken();
    expect(second).not.toBe(first);
    expectError(await t.post("/auth/consent/review", { token: first }), 400, "invalid_token");
    expect((await confirm(second)).statusCode).toBe(200);
  });

  it("resend after expiry sends a fresh 7-day link", async () => {
    await pendingMinor();
    t.clock.advance(8 * DAY);
    const { accessToken } = await logIn();
    expect((await requestConsent(accessToken)).statusCode).toBe(200);
    expect((await consentStatus(accessToken)).state).toBe("pending");
    expect((await confirm(guardianToken())).statusCode).toBe(200);
  });

  it("the member can change the guardian; only the new guardian's link works", async () => {
    const { accessToken } = await pendingMinor();
    const mumToken = guardianToken(MUM);

    const response = await requestConsent(accessToken, { guardianEmail: " Dad@Example.com " });
    expect(response.statusCode, response.body).toBe(200);
    expect(consentStatusResponseSchema.parse(response.json())).toMatchObject({
      state: "pending",
      guardianEmail: DAD,
    });
    expect((await userRow(KID))?.guardianEmail).toBe(DAD);
    expectError(await confirm(mumToken), 400, "invalid_token");
    expect((await confirm(guardianToken(DAD))).statusCode).toBe(200);
    expect((await userRow(KID))?.status).toBe("active");
  });

  it("the new guardian email must differ from the member's", async () => {
    const { accessToken } = await pendingMinor();
    const error = expectError(
      await requestConsent(accessToken, { guardianEmail: KID.toUpperCase() }),
      400,
      "validation_error",
    );
    expect(error.fieldErrors?.guardianEmail).toBeDefined();
  });

  it("after a decline the member can ask a different guardian, but not the same one again", async () => {
    const { accessToken } = await pendingMinor();
    await decline(guardianToken(MUM));

    expectError(await requestConsent(accessToken), 409, "guardian_declined");
    expectError(
      await requestConsent(accessToken, { guardianEmail: MUM }),
      409,
      "guardian_declined",
    );

    expect((await requestConsent(accessToken, { guardianEmail: DAD })).statusCode).toBe(200);
    expect((await consentStatus(accessToken)).state).toBe("pending");
    // Switching back to the guardian who declined is refused too.
    expectError(
      await requestConsent(accessToken, { guardianEmail: MUM }),
      409,
      "guardian_declined",
    );
    expect((await confirm(guardianToken(DAD))).statusCode).toBe(200);
  });

  it("before verifying, changing the guardian only stores it; the new guardian is emailed on verification", async () => {
    await signUpMinor();
    const { accessToken } = await logIn();
    const response = await requestConsent(accessToken, { guardianEmail: DAD });
    expect(response.statusCode).toBe(200);
    expect(consentStatusResponseSchema.parse(response.json())).toMatchObject({
      state: "awaiting_member_verification",
      guardianEmail: DAD,
    });
    expect(t.mailer.messages.some((m) => m.type === "guardian_consent")).toBe(false);

    await verify();
    expect(t.mailer.lastTo(DAD, "guardian_consent")).toBeDefined();
    expect(t.mailer.lastTo(MUM, "guardian_consent")).toBeUndefined();
  });

  it("adults and members who already have consent get 409 consent_not_required", async () => {
    const adult = await t.signUpVerified("ana@example.com");
    expectError(await requestConsent(adult.accessToken), 409, "consent_not_required");
    expect((await consentStatus(adult.accessToken)).state).toBe("not_required");

    const { accessToken } = await pendingMinor();
    await confirm(guardianToken());
    expectError(await requestConsent(accessToken), 409, "consent_not_required");
  });

  it("the consent endpoints for members need a login", async () => {
    expectError(await get("/auth/consent"), 401, "unauthorized");
    expectError(await t.post("/auth/consent/request", {}), 401, "unauthorized");
  });
});

describe("AC: the consent record (who, when, how) is stored and auditable", () => {
  it("records who was asked, when, the decision, from where and how", async () => {
    await pendingMinor();
    t.clock.advance(3_600_000);
    await t.app.inject({
      method: "POST",
      url: "/auth/consent/decision",
      payload: { token: guardianToken(), decision: "confirm", isParentOrGuardian: true },
      remoteAddress: "198.51.100.7",
      headers: { "user-agent": "GuardianBrowser/1.0" },
    });

    const [row] = await consentRows(KID);
    expect(row).toMatchObject({
      guardianEmail: MUM,
      memberDateOfBirth: KID_DOB,
      method: "email_link",
      status: "confirmed",
      requestedAt: NOW,
      expiresAt: new Date(NOW.getTime() + 7 * DAY),
      decidedAt: new Date(NOW.getTime() + 3_600_000),
      decidedIp: "198.51.100.7",
      decidedUserAgent: "GuardianBrowser/1.0",
      guardianAttested: true,
      supersededAt: null,
    });
  });

  it("keeps every request: superseded, declined and confirmed", async () => {
    const { accessToken } = await pendingMinor();
    t.clock.advance(1_000);
    await requestConsent(accessToken); // supersedes the first
    await decline(guardianToken(MUM));
    t.clock.advance(1_000);
    await requestConsent(accessToken, { guardianEmail: DAD });
    await confirm(guardianToken(DAD));

    const rows = await consentRows(KID);
    expect(rows.map((r) => [r.guardianEmail, r.status, r.guardianAttested])).toEqual([
      [MUM, "superseded", false],
      [MUM, "declined", false],
      [DAD, "confirmed", true],
    ]);
    expect(rows[0]?.supersededAt).not.toBeNull();
  });

  it("stores only a hash of the link token", async () => {
    await pendingMinor();
    const token = guardianToken();
    const [row] = await consentRows(KID);
    expect(row?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    const all = JSON.stringify(await connection.db.select().from(guardianConsentRequests));
    expect(all).not.toContain(token);
  });

  it("a member with consent records cannot be deleted by accident", async () => {
    await pendingMinor();
    await expect(connection.db.delete(users).where(eq(users.email, KID))).rejects.toThrow();
  });
});

describe("one server-side check for a fully active account", () => {
  async function appWithMemberRoute() {
    t.app.get(
      "/test/member-feature",
      { preHandler: requireActiveAccount(t.app.authService!) },
      async () => ({ ok: true }),
    );
    await t.app.ready();
  }

  it("lets active accounts through and stops pending ones with 403 account_not_active", async () => {
    await appWithMemberRoute();
    const adult = await t.signUpVerified("ana@example.com");
    expect((await get("/test/member-feature", adult.accessToken)).statusCode).toBe(200);

    await signUpMinor();
    const unverified = await logIn();
    expect(
      expectError(
        await get("/test/member-feature", unverified.accessToken),
        403,
        "account_not_active",
      ).message,
    ).toMatch(/verify/i);

    await verify();
    const pending = await logIn();
    expect(
      expectError(await get("/test/member-feature", pending.accessToken), 403, "account_not_active")
        .message,
    ).toMatch(/guardian/i);

    await confirm(guardianToken());
    expect((await get("/test/member-feature", pending.accessToken)).statusCode).toBe(200);

    expectError(await get("/test/member-feature"), 401, "unauthorized");
  });
});

describe("rate limits", () => {
  it("limits resends per account (429 with Retry-After)", async () => {
    await t.app.close();
    t = await buildAuthApp(connection, {
      rateLimits: { consentRequestsPerAccount: { max: 2, windowMs: 60 * 60_000 } },
    });
    t.clock.current = new Date(NOW);
    const { accessToken } = await pendingMinor();
    expect((await requestConsent(accessToken)).statusCode).toBe(200);
    expect((await requestConsent(accessToken)).statusCode).toBe(200);
    const limited = await requestConsent(accessToken);
    expectError(limited, 429, "rate_limited");
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("limits emails to one guardian; a limited first email leaves the state not_sent", async () => {
    await t.app.close();
    t = await buildAuthApp(connection, {
      rateLimits: { consentEmailsPerGuardian: { max: 1, windowMs: 60 * 60_000 } },
    });
    t.clock.current = new Date(NOW);
    await pendingMinor("sibling1@example.com", MUM);
    const second = await pendingMinor("sibling2@example.com", MUM);
    expect(t.mailer.messages.filter((m) => m.type === "guardian_consent")).toHaveLength(1);
    expect((await consentStatus(second.accessToken)).state).toBe("not_sent");
    expectError(await requestConsent(second.accessToken), 429, "rate_limited");

    t.clock.advance(60 * 60_000);
    const { accessToken } = await logIn("sibling2@example.com");
    expect((await requestConsent(accessToken)).statusCode).toBe(200);
    expect((await consentStatus(accessToken)).state).toBe("pending");
  });

  it("counts consent review and decision as link-token attempts per IP", async () => {
    await t.app.close();
    t = await buildAuthApp(connection, {
      rateLimits: { tokenAttemptsPerIp: { max: 2, windowMs: 15 * 60_000 } },
    });
    expect((await t.post("/auth/consent/review", { token: "plc_a" })).statusCode).toBe(400);
    expect((await confirm("plc_b")).statusCode).toBe(400);
    expectError(await t.post("/auth/consent/review", { token: "plc_c" }), 429, "rate_limited");
  });
});

describe("edge cases", () => {
  it("a member who turns 18 before verifying becomes active straight away", async () => {
    t.clock.current = new Date("2026-11-23T20:00:00Z");
    await signUpMinor(KID, MUM, "2008-11-24");
    t.clock.current = new Date("2026-11-24T08:00:00Z");
    expect((await verify()).accountStatus).toBe("active");
    expect(t.mailer.messages.some((m) => m.type === "guardian_consent")).toBe(false);
  });

  it("accounts from before #3 (no date of birth) stay active and need no consent", async () => {
    const adult = await t.signUpVerified("old@example.com");
    await connection.db
      .update(users)
      .set({ dateOfBirth: null })
      .where(eq(users.email, "old@example.com"));
    expect((await t.me(adult.accessToken)).json().user.status).toBe("active");
    expect((await consentStatus(adult.accessToken)).state).toBe("not_required");
  });

  it("signing up again with a registered email changes nothing about the existing account", async () => {
    await pendingMinor();
    const again = await t.post("/auth/signup", {
      email: KID,
      password: PASSWORD,
      dateOfBirth: ADULT_DOB,
    });
    expect(again.statusCode).toBe(202);
    expect(await userRow(KID)).toMatchObject({
      dateOfBirth: KID_DOB,
      guardianEmail: MUM,
      status: "pending_consent",
    });
  });

  it("the consent email link carries the token, and tokenFromLink reads it", async () => {
    await pendingMinor();
    const link = t.mailer.lastTo(MUM, "guardian_consent")?.link ?? "";
    expect(tokenFromLink(link)).toMatch(/^plc_/);
  });
});
