/**
 * QA (issue #3): date of birth at sign-up, the under-18 rule and the guardian
 * email rules (docs/api/consent.md, "POST /auth/signup (changed)" and
 * "POST /auth/verify-email (changed)").
 *
 * AC1: date of birth is captured at sign-up.
 * AC2 (part): members under 18 must enter a parent/guardian email.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseConnection } from "../src/db/client.js";
import {
  ADULT_DOB,
  expectApiError,
  type Harness,
  logIn,
  openTestDatabase,
  PASSWORD,
  post,
  uniqueEmail,
} from "./support/auth-harness.js";
import {
  consentEmails,
  consentRows,
  consentToken,
  dobYearsAgo,
  getConsent,
  guardianEmail,
  makeConsentHarness,
  memberOnly,
  signUpMinor,
  todayUtc,
  verifyMember,
} from "./support/consent-harness.js";

let connection: DatabaseConnection;
let h: Harness;

beforeAll(async () => {
  connection = await openTestDatabase();
});
afterAll(async () => {
  await connection.pool.end();
});

async function harness(now?: string) {
  h = await makeConsentHarness(connection, now ? { now } : {});
  return h;
}
afterEach(async () => {
  await h?.app.close();
});

function signUpBody(fields: Record<string, unknown>) {
  return { email: uniqueEmail(), password: PASSWORD, ...fields };
}

async function expectFieldError(
  body: Record<string, unknown>,
  field: "dateOfBirth" | "guardianEmail" | "email",
) {
  const error = expectApiError(await post(h.app, "/auth/signup", body), 400, "validation_error");
  expect(error.error.fieldErrors?.[field]?.length, JSON.stringify(error)).toBeGreaterThan(0);
  return error;
}

describe("AC1: date of birth is required at sign-up", () => {
  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["whitespace", "   "],
    ["null", null],
    ["a number", 20100105],
    ["an object", { year: 2010 }],
  ])("rejects a date of birth that is %s (field dateOfBirth)", async (_name, dateOfBirth) => {
    await harness();
    await expectFieldError(signUpBody({ dateOfBirth }), "dateOfBirth");
  });

  it.each([
    ["day first", "31/01/2010"],
    ["no zero padding", "2010-1-5"],
    ["no separators", "20100105"],
    ["with a time", "2010-01-05T00:00:00Z"],
    ["letters", "abcd-ef-gh"],
    ["month 13", "2010-13-01"],
    ["month 00", "2010-00-10"],
    ["day 00", "2010-01-00"],
    ["31 April", "2010-04-31"],
    ["30 February", "2012-02-30"],
    ["29 February in a common year", "2011-02-29"],
    ["29 February 1900 (not a leap year)", "1900-02-29"],
    ["5-digit year", "12010-01-05"],
  ])("rejects a malformed or impossible date (%s)", async (_name, dateOfBirth) => {
    await harness();
    await expectFieldError(
      signUpBody({ dateOfBirth, guardianEmail: guardianEmail() }),
      "dateOfBirth",
    );
  });

  it("rejects a date of birth before 1900-01-01 and accepts 1900-01-01", async () => {
    await harness();
    await expectFieldError(signUpBody({ dateOfBirth: "1899-12-31" }), "dateOfBirth");
    const ok = await post(h.app, "/auth/signup", signUpBody({ dateOfBirth: "1900-01-01" }));
    expect(ok.statusCode, ok.body).toBe(202);
  });

  it("rejects tomorrow and far-future dates; accepts today (with a guardian)", async () => {
    await harness();
    const g = guardianEmail();
    await expectFieldError(
      signUpBody({ dateOfBirth: dobYearsAgo(h, 0, 1), guardianEmail: g }),
      "dateOfBirth",
    );
    await expectFieldError(
      signUpBody({ dateOfBirth: "2999-01-01", guardianEmail: g }),
      "dateOfBirth",
    );
    const today = await post(
      h.app,
      "/auth/signup",
      signUpBody({ dateOfBirth: todayUtc(h), guardianEmail: g }),
    );
    expect(today.statusCode, today.body).toBe(202);
  });

  it("accepts a real 29 February in a leap year", async () => {
    await harness();
    const response = await post(h.app, "/auth/signup", signUpBody({ dateOfBirth: "2000-02-29" }));
    expect(response.statusCode, response.body).toBe(202);
  });

  it("stores the date of birth: the guardian sees it on the consent review", async () => {
    await harness();
    const minor = await signUpMinor(h, { dateOfBirth: "2012-05-01" });
    await verifyMember(h, minor.email);
    const token = consentToken(h, minor.guardian);
    const response = await post(h.app, "/auth/consent/review", { token });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().memberDateOfBirth).toBe("2012-05-01");
    const rows = await consentRows(connection, minor.email);
    expect(rows[0]?.dob_text).toBe("2012-05-01");
  });
});

describe("AC2: under-18s must give a guardian email", () => {
  it("rejects an under-18 sign-up without guardianEmail (field guardianEmail)", async () => {
    await harness();
    await expectFieldError(signUpBody({ dateOfBirth: dobYearsAgo(h, 15) }), "guardianEmail");
  });

  it.each([
    ["empty", ""],
    ["whitespace", "   "],
    ["not an email", "mum-at-example.com"],
    ["no domain", "mum@"],
    ["null", null],
  ])("rejects a guardianEmail that is %s", async (_name, guardian) => {
    await harness();
    await expectFieldError(
      signUpBody({ dateOfBirth: dobYearsAgo(h, 15), guardianEmail: guardian }),
      "guardianEmail",
    );
  });

  it("rejects a guardian email equal to the member's, also differing only in case or spaces", async () => {
    await harness();
    const email = uniqueEmail("junior");
    const dateOfBirth = dobYearsAgo(h, 15);
    for (const guardian of [
      email,
      email.toUpperCase(),
      `  ${email}  `,
      `\t${email.replace(/^j/, "J")}\n`,
    ]) {
      await expectFieldError(
        { email, password: PASSWORD, dateOfBirth, guardianEmail: guardian },
        "guardianEmail",
      );
    }
    // ...and the other way round: the member's email in upper case, the guardian's lower.
    await expectFieldError(
      { email: email.toUpperCase(), password: PASSWORD, dateOfBirth, guardianEmail: email },
      "guardianEmail",
    );
    // Nothing was created: no verification email to that address.
    expect(h.mailer.messages.filter((m) => m.to === email)).toHaveLength(0);
  });

  it("normalises the guardian email (trim + lower case) before storing and emailing it", async () => {
    await harness();
    const g = guardianEmail();
    const minor = await signUpMinor(h, { guardian: `  ${g.toUpperCase()} ` });
    await verifyMember(h, minor.email);
    expect(consentEmails(h, g)).toHaveLength(1);
    const session = await logIn(h, minor.email);
    expect((await getConsent(h, session.accessToken)).guardianEmail).toBe(g);
  });

  it("does not email the guardian at sign-up, only once the member verifies", async () => {
    await harness();
    const minor = await signUpMinor(h);
    expect(h.mailer.messages.filter((m) => m.to === minor.guardian)).toHaveLength(0);
    const session = await logIn(h, minor.email);
    const consent = await getConsent(h, session.accessToken);
    expect(consent).toMatchObject({
      state: "awaiting_member_verification",
      guardianEmail: minor.guardian,
      requestedAt: null,
      expiresAt: null,
      decidedAt: null,
    });
    expect(session.user.status).toBe("pending_verification");
  });

  it("an adult's guardianEmail is ignored: no consent step, no email, active on verify", async () => {
    await harness();
    const email = uniqueEmail("adult");
    const g = guardianEmail();
    const response = await post(h.app, "/auth/signup", {
      email,
      password: PASSWORD,
      dateOfBirth: ADULT_DOB,
      guardianEmail: g,
    });
    expect(response.statusCode, response.body).toBe(202);
    expect((await verifyMember(h, email)).accountStatus).toBe("active");
    expect(h.mailer.messages.filter((m) => m.to === g)).toHaveLength(0);
    const session = await logIn(h, email);
    expect(session.user.status).toBe("active");
    expect(await getConsent(h, session.accessToken)).toEqual({
      state: "not_required",
      guardianEmail: null,
      requestedAt: null,
      expiresAt: null,
      decidedAt: null,
    });
    expect((await memberOnly(h, session.accessToken)).statusCode).toBe(200);
  });
});

describe("Age boundaries (calendar dates, today's date in UTC)", () => {
  async function outcome(now: string, dateOfBirth: string) {
    await harness(now);
    const email = uniqueEmail("boundary");
    const without = await post(h.app, "/auth/signup", { email, password: PASSWORD, dateOfBirth });
    if (without.statusCode === 202) {
      const verified = await verifyMember(h, email);
      return { needsGuardian: false, accountStatus: verified.accountStatus };
    }
    const error = expectApiError(without, 400, "validation_error");
    expect(error.error.fieldErrors?.guardianEmail?.length).toBeGreaterThan(0);
    const minor = await signUpMinor(h, { email, dateOfBirth });
    const verified = await verifyMember(h, minor.email);
    return { needsGuardian: true, accountStatus: verified.accountStatus };
  }

  it("18 today is an adult: no guardian needed, active on verify", async () => {
    expect(await outcome("2026-11-24T12:00:00Z", "2008-11-24")).toEqual({
      needsGuardian: false,
      accountStatus: "active",
    });
  });

  it("18 tomorrow is under 18: guardian needed, pending_consent on verify", async () => {
    expect(await outcome("2026-11-24T12:00:00Z", "2008-11-25")).toEqual({
      needsGuardian: true,
      accountStatus: "pending_consent",
    });
  });

  it("17 years and 364 days old is under 18; 19 is an adult", async () => {
    expect((await outcome("2026-11-24T12:00:00Z", "2008-11-25")).needsGuardian).toBe(true);
    await h.app.close();
    expect((await outcome("2026-11-24T12:00:00Z", "2007-11-24")).needsGuardian).toBe(false);
  });

  it("29 February birthday: still under 18 on 28 February of a common year", async () => {
    expect((await outcome("2026-02-28T12:00:00Z", "2008-02-29")).needsGuardian).toBe(true);
  });

  it("29 February birthday: 18 on 1 March of a common year", async () => {
    expect((await outcome("2026-03-01T12:00:00Z", "2008-02-29")).needsGuardian).toBe(false);
  });

  it("29 February birthday: under 18 to the last second of 28 Feb (UTC), adult at 00:00 on 1 Mar", async () => {
    expect((await outcome("2030-02-28T23:59:59Z", "2012-02-29")).needsGuardian).toBe(true);
    await h.app.close();
    expect((await outcome("2030-03-01T00:00:00Z", "2012-02-29")).needsGuardian).toBe(false);
  });

  it("uses the UTC date: one second before midnight UTC the birthday has not started", async () => {
    // 23:59:59 UTC on 23 Nov is already 24 Nov in Jakarta (UTC+7), but the API uses UTC.
    expect((await outcome("2026-11-23T23:59:59Z", "2008-11-24")).needsGuardian).toBe(true);
  });

  it("uses the UTC date: at midnight UTC on the 18th birthday the member is an adult", async () => {
    // 00:00 UTC on 24 Nov is still 23 Nov in New York, but the API uses UTC.
    expect((await outcome("2026-11-24T00:00:00Z", "2008-11-24")).needsGuardian).toBe(false);
  });

  it("a member who turns 18 between sign-up and verifying goes straight to active", async () => {
    await harness("2026-11-23T18:00:00Z");
    const minor = await signUpMinor(h, { dateOfBirth: "2008-11-24" });
    // 7 hours later it is 24 Nov (UTC); the 24-hour verify link is still valid.
    h.clock.advance(7 * 60 * 60 * 1000);
    expect((await verifyMember(h, minor.email)).accountStatus).toBe("active");
    expect(consentEmails(h, minor.guardian)).toHaveLength(0);
  });
});

describe("Sign-up stays non-enumerating and does not change existing accounts", () => {
  it("answers adult, under-18 and already-registered sign-ups identically", async () => {
    await harness();
    const adult = await post(h.app, "/auth/signup", signUpBody({ dateOfBirth: ADULT_DOB }));
    const minor = await post(
      h.app,
      "/auth/signup",
      signUpBody({ dateOfBirth: dobYearsAgo(h, 15), guardianEmail: guardianEmail() }),
    );
    const existing = await signUpMinor(h);
    const again = await post(h.app, "/auth/signup", {
      email: existing.email,
      password: PASSWORD,
      dateOfBirth: ADULT_DOB,
    });
    for (const r of [adult, minor, again]) expect(r.statusCode, r.body).toBe(202);
    expect(minor.json()).toEqual(adult.json());
    expect(again.json()).toEqual(adult.json());
  });

  it("signing up again with an adult date of birth does not skip consent for an existing junior", async () => {
    await harness();
    const minor = await signUpMinor(h);
    await post(h.app, "/auth/signup", {
      email: minor.email,
      password: "another password 123",
      dateOfBirth: ADULT_DOB,
    });
    expect((await verifyMember(h, minor.email)).accountStatus).toBe("pending_consent");
    expect(consentEmails(h, minor.guardian)).toHaveLength(1);
  });

  it("signing up again with another guardian email does not change the guardian", async () => {
    await harness();
    const minor = await signUpMinor(h);
    const other = guardianEmail();
    await post(h.app, "/auth/signup", {
      email: minor.email,
      password: PASSWORD,
      dateOfBirth: minor.dateOfBirth,
      guardianEmail: other,
    });
    await verifyMember(h, minor.email);
    expect(consentEmails(h, minor.guardian)).toHaveLength(1);
    expect(h.mailer.messages.filter((m) => m.to === other)).toHaveLength(0);
  });
});
