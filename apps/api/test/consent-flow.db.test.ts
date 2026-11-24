/**
 * QA (issue #3): the guardian consent flow (docs/api/consent.md).
 *
 * AC2: the guardian gets a single-use, expiring consent link and can confirm or decline.
 * AC3: until consent is given the account is pending, the member is told why and can resend.
 * AC4: the consent record (who, when) is stored and auditable.
 */
import { createHash } from "node:crypto";
import {
  consentDecisionResponseSchema,
  consentReviewResponseSchema,
  consentStatusResponseSchema,
} from "@padelloyalty/shared";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseConnection } from "../src/db/client.js";
import { tokenFromLink } from "../src/email/mailer.js";
import {
  activeMember,
  APP_URL,
  expectApiError,
  type Harness,
  lastToken,
  logIn,
  openTestDatabase,
  PASSWORD,
  post,
  signUp,
  uniqueEmail,
} from "./support/auth-harness.js";
import {
  CONSENT_LINK_MS,
  confirm,
  consentEmails,
  consentRows,
  consentToken,
  decline,
  FIXED_NOW,
  get,
  getConsent,
  guardianEmail,
  makeConsentHarness,
  memberOnly,
  meStatus,
  pendingMinor,
  requestConsent,
  review,
  signUpMinor,
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
beforeEach(async () => {
  h = await makeConsentHarness(connection);
});
afterEach(async () => {
  await h.app.close();
});

const SECOND = 1000;

describe("Verification moves an under-18 to pending_consent and emails the guardian", () => {
  it("verify answers pending_consent and the guardian gets one consent link", async () => {
    const minor = await signUpMinor(h);
    const verified = await verifyMember(h, minor.email);
    expect(verified.accountStatus).toBe("pending_consent");

    const emails = consentEmails(h);
    expect(emails).toHaveLength(1);
    expect(emails[0]!.to).toBe(minor.guardian);
    expect(emails[0]!.link).toMatch(
      new RegExp(`^${APP_URL.replace(/\./g, "\\.")}/guardian-consent/#token=plc_[^&\\s]+$`),
    );
    // The email names the member and says the link expires in 7 days.
    expect(emails[0]!.text).toContain(minor.email);
    expect(emails[0]!.text).toMatch(/7 days/i);
    // The member does not receive the guardian's link.
    expect(h.mailer.messages.filter((m) => m.to === minor.email).map((m) => m.type)).toEqual([
      "verify_email",
    ]);
  });

  it("a pending_consent member can log in and is told why (status, guardian, expiry)", async () => {
    const minor = await pendingMinor(h);
    expect(minor.session.user.status).toBe("pending_consent");
    expect(await meStatus(h, minor.session.accessToken)).toBe("pending_consent");
    const consent = await getConsent(h, minor.session.accessToken);
    expect(consent).toEqual({
      state: "pending",
      guardianEmail: minor.guardian,
      requestedAt: FIXED_NOW,
      expiresAt: new Date(Date.parse(FIXED_NOW) + CONSENT_LINK_MS).toISOString(),
      decidedAt: null,
    });
  });

  it("verifying through a password reset also emails the guardian", async () => {
    const minor = await signUpMinor(h);
    await post(h.app, "/auth/password-reset/request", { email: minor.email });
    const reset = await post(h.app, "/auth/password-reset/confirm", {
      token: lastToken(h.mailer, minor.email, "password_reset"),
      password: "a new password 123",
    });
    expect(reset.statusCode, reset.body).toBe(200);
    expect(consentEmails(h, minor.guardian)).toHaveLength(1);
    const session = await logIn(h, minor.email, "a new password 123");
    expect(session.user.status).toBe("pending_consent");
    // ...and the old verify link (if still accepted) does not send a second consent email.
    await post(h.app, "/auth/verify-email", {
      token: lastToken(h.mailer, minor.email, "verify_email"),
    });
    expect(consentEmails(h)).toHaveLength(1);
  });

  it("GET /auth/consent needs a valid bearer token", async () => {
    expectApiError(await get(h, "/auth/consent"), 401, "unauthorized");
    expectApiError(await get(h, "/auth/consent", "pla_nope"), 401, "unauthorized");
  });
});

describe("Pending accounts cannot use member features (requireActiveAccount)", () => {
  it("401 without a token, 403 account_not_active while pending_verification", async () => {
    expectApiError(await memberOnly(h), 401, "unauthorized");
    const minor = await signUpMinor(h);
    const session = await logIn(h, minor.email);
    const error = expectApiError(
      await memberOnly(h, session.accessToken),
      403,
      "account_not_active",
    );
    expect(error.error.message.length).toBeGreaterThan(0);
  });

  it("403 account_not_active while pending_consent, with a message saying why", async () => {
    const minor = await pendingMinor(h);
    const error = expectApiError(
      await memberOnly(h, minor.session.accessToken),
      403,
      "account_not_active",
    );
    expect(error.error.message).toMatch(/consent|guardian|parent/i);
  });

  it("200 once the guardian confirms, with the session the member already had", async () => {
    const minor = await pendingMinor(h);
    expect((await confirm(h, minor.token)).statusCode).toBe(200);
    expect((await memberOnly(h, minor.session.accessToken)).statusCode).toBe(200);
  });

  it("adult accounts are unaffected: 200 after verification", async () => {
    const adult = await activeMember(h);
    expect((await memberOnly(h, adult.session.accessToken)).statusCode).toBe(200);
  });
});

describe("Guardian review", () => {
  it("shows the member's email, date of birth, guardian and expiry, and nothing else", async () => {
    const minor = await pendingMinor(h, { dateOfBirth: "2012-05-01" });
    const response = await review(h, minor.token);
    expect(response.statusCode, response.body).toBe(200);
    const body = consentReviewResponseSchema.strict().parse(response.json());
    expect(body).toEqual({
      memberEmail: minor.email,
      memberDateOfBirth: "2012-05-01",
      guardianEmail: minor.guardian,
      expiresAt: new Date(Date.parse(FIXED_NOW) + CONSENT_LINK_MS).toISOString(),
    });
  });

  it("does not use up the link: review twice, then confirm", async () => {
    const minor = await pendingMinor(h);
    expect((await review(h, minor.token)).statusCode).toBe(200);
    expect((await review(h, minor.token)).statusCode).toBe(200);
    expect((await confirm(h, minor.token)).statusCode).toBe(200);
  });
});

describe("Guardian confirms", () => {
  it("activates the account and records the decision", async () => {
    const minor = await pendingMinor(h);
    h.clock.advance(3 * 60 * 60 * SECOND);
    const response = await confirm(h, minor.token);
    expect(response.statusCode, response.body).toBe(200);
    expect(consentDecisionResponseSchema.parse(response.json()).decision).toBe("confirm");

    expect(await meStatus(h, minor.session.accessToken)).toBe("active");
    const consent = await getConsent(h, minor.session.accessToken);
    expect(consent.state).toBe("granted");
    expect(consent.decidedAt).toBe(h.clock.now().toISOString());
    const login = await logIn(h, minor.email);
    expect(login.user.status).toBe("active");
  });

  it("requires isParentOrGuardian: true", async () => {
    const minor = await pendingMinor(h);
    for (const isParentOrGuardian of [undefined, false, "true", 1, null]) {
      expectApiError(
        await post(h.app, "/auth/consent/decision", {
          token: minor.token,
          decision: "confirm",
          isParentOrGuardian,
        }),
        400,
        "validation_error",
      );
    }
    // The rejected attempts did not use up the link.
    expect((await confirm(h, minor.token)).statusCode).toBe(200);
  });

  it("rejects unknown decisions and missing tokens with 400 validation_error", async () => {
    const minor = await pendingMinor(h);
    for (const body of [
      { token: minor.token, decision: "approve", isParentOrGuardian: true },
      { token: minor.token },
      { decision: "confirm", isParentOrGuardian: true },
      { token: "", decision: "decline" },
      { token: "x".repeat(513), decision: "decline" },
    ]) {
      expectApiError(await post(h.app, "/auth/consent/decision", body), 400, "validation_error");
    }
    expect(await meStatus(h, minor.session.accessToken)).toBe("pending_consent");
  });

  it("the link is single use: a second decision and a later review are invalid_token", async () => {
    const minor = await pendingMinor(h);
    expect((await confirm(h, minor.token)).statusCode).toBe(200);
    expectApiError(await confirm(h, minor.token), 400, "invalid_token");
    expectApiError(await decline(h, minor.token), 400, "invalid_token");
    expectApiError(await review(h, minor.token), 400, "invalid_token");
    expect(await meStatus(h, minor.session.accessToken)).toBe("active");
  });

  it("asking for consent again after it was granted is 409 consent_not_required", async () => {
    const minor = await pendingMinor(h);
    await confirm(h, minor.token);
    expectApiError(await requestConsent(h, minor.session.accessToken), 409, "consent_not_required");
    expectApiError(
      await requestConsent(h, minor.session.accessToken, { guardianEmail: guardianEmail() }),
      409,
      "consent_not_required",
    );
  });
});

describe("Guardian declines", () => {
  it("keeps the account pending and tells the member", async () => {
    const minor = await pendingMinor(h);
    h.clock.advance(60 * SECOND);
    const response = await decline(h, minor.token);
    expect(response.statusCode, response.body).toBe(200);
    expect(consentDecisionResponseSchema.parse(response.json()).decision).toBe("decline");

    expect(await meStatus(h, minor.session.accessToken)).toBe("pending_consent");
    const consent = await getConsent(h, minor.session.accessToken);
    expect(consent).toMatchObject({
      state: "declined",
      guardianEmail: minor.guardian,
      decidedAt: h.clock.now().toISOString(),
    });
    expectApiError(await memberOnly(h, minor.session.accessToken), 403, "account_not_active");
    // The link is used up.
    expectApiError(await confirm(h, minor.token), 400, "invalid_token");
  });

  it("the same guardian cannot be asked again (also with different case / spaces)", async () => {
    const minor = await pendingMinor(h);
    await decline(h, minor.token);
    for (const body of [
      {},
      { guardianEmail: minor.guardian },
      { guardianEmail: `  ${minor.guardian.toUpperCase()}  ` },
    ]) {
      expectApiError(
        await requestConsent(h, minor.session.accessToken, body),
        409,
        "guardian_declined",
      );
    }
    expect(consentEmails(h, minor.guardian)).toHaveLength(1);
  });

  it("the member can nominate another guardian, who can then confirm", async () => {
    const minor = await pendingMinor(h);
    await decline(h, minor.token);
    h.clock.advance(60 * SECOND);
    const other = guardianEmail();
    const response = await requestConsent(h, minor.session.accessToken, { guardianEmail: other });
    expect(response.statusCode, response.body).toBe(200);
    expect(consentStatusResponseSchema.parse(response.json())).toMatchObject({
      state: "pending",
      guardianEmail: other,
      decidedAt: null,
    });
    expect((await confirm(h, consentToken(h, other))).statusCode).toBe(200);
    expect(await meStatus(h, minor.session.accessToken)).toBe("active");
  });
});

describe("Resend and change guardian", () => {
  it("resend issues a new link and invalidates the old one", async () => {
    const minor = await pendingMinor(h);
    h.clock.advance(60 * SECOND);
    const response = await requestConsent(h, minor.session.accessToken);
    expect(response.statusCode, response.body).toBe(200);
    const status = consentStatusResponseSchema.parse(response.json());
    expect(status).toMatchObject({
      state: "pending",
      guardianEmail: minor.guardian,
      requestedAt: h.clock.now().toISOString(),
      expiresAt: new Date(h.clock.now().getTime() + CONSENT_LINK_MS).toISOString(),
    });
    const fresh = consentToken(h, minor.guardian);
    expect(fresh).not.toBe(minor.token);
    expectApiError(await review(h, minor.token), 400, "invalid_token");
    expectApiError(await confirm(h, minor.token), 400, "invalid_token");
    expectApiError(await decline(h, minor.token), 400, "invalid_token");
    expect((await confirm(h, fresh)).statusCode).toBe(200);
  });

  it("after several resends only the newest link works", async () => {
    const minor = await pendingMinor(h);
    const tokens = [minor.token];
    for (let i = 0; i < 3; i++) {
      h.clock.advance(60 * SECOND);
      expect((await requestConsent(h, minor.session.accessToken)).statusCode).toBe(200);
      tokens.push(consentToken(h, minor.guardian));
    }
    expect(new Set(tokens).size).toBe(4);
    for (const old of tokens.slice(0, -1)) {
      expectApiError(await review(h, old), 400, "invalid_token");
    }
    expect((await review(h, tokens.at(-1))).statusCode).toBe(200);
  });

  it("changing the guardian kills the old guardian's link and emails the new one", async () => {
    const minor = await pendingMinor(h);
    h.clock.advance(60 * SECOND);
    const other = guardianEmail();
    const response = await requestConsent(h, minor.session.accessToken, {
      guardianEmail: `  ${other.toUpperCase()} `,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().guardianEmail).toBe(other);
    expect(consentEmails(h, other)).toHaveLength(1);
    expectApiError(await confirm(h, minor.token), 400, "invalid_token");
    expect((await getConsent(h, minor.session.accessToken)).guardianEmail).toBe(other);
  });

  it("rejects the member's own email as guardian, in any case or with spaces", async () => {
    const minor = await pendingMinor(h);
    for (const guardian of [minor.email, minor.email.toUpperCase(), ` ${minor.email} `]) {
      const error = expectApiError(
        await requestConsent(h, minor.session.accessToken, { guardianEmail: guardian }),
        400,
        "validation_error",
      );
      expect(error.error.fieldErrors?.guardianEmail?.length).toBeGreaterThan(0);
    }
    // The original link still works: a rejected change did not supersede it.
    expect((await review(h, minor.token)).statusCode).toBe(200);
  });

  it("rejects an invalid guardian email", async () => {
    const minor = await pendingMinor(h);
    for (const guardianEmail of ["", "nope", 42, null]) {
      expectApiError(
        await requestConsent(h, minor.session.accessToken, { guardianEmail }),
        400,
        "validation_error",
      );
    }
  });

  it("before verification, a change only stores the guardian; the email goes out on verify", async () => {
    const minor = await signUpMinor(h);
    const session = await logIn(h, minor.email);
    const other = guardianEmail();
    const response = await requestConsent(h, session.accessToken, { guardianEmail: other });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      state: "awaiting_member_verification",
      guardianEmail: other,
    });
    // Resend before verification sends nothing either.
    expect((await requestConsent(h, session.accessToken)).statusCode).toBe(200);
    expect(consentEmails(h)).toHaveLength(0);

    await verifyMember(h, minor.email);
    expect(consentEmails(h, other)).toHaveLength(1);
    expect(consentEmails(h, minor.guardian)).toHaveLength(0);
  });

  it("adults get 409 consent_not_required, verified or not", async () => {
    const adult = await activeMember(h);
    expectApiError(await requestConsent(h, adult.session.accessToken), 409, "consent_not_required");
    const unverified = uniqueEmail("adult");
    await signUp(h, unverified);
    const session = await logIn(h, unverified);
    expectApiError(
      await requestConsent(h, session.accessToken, { guardianEmail: guardianEmail() }),
      409,
      "consent_not_required",
    );
    expect(consentEmails(h)).toHaveLength(0);
  });

  it("needs a valid bearer token", async () => {
    expectApiError(await post(h.app, "/auth/consent/request", {}), 401, "unauthorized");
  });
});

describe("Link expiry (7 days)", () => {
  it("works one second before expiry and is invalid_token one second after", async () => {
    const minor = await pendingMinor(h);
    h.clock.advance(CONSENT_LINK_MS - SECOND);
    expect((await review(h, minor.token)).statusCode).toBe(200);
    h.clock.advance(2 * SECOND);
    expectApiError(await review(h, minor.token), 400, "invalid_token");
    expectApiError(await confirm(h, minor.token), 400, "invalid_token");
    expectApiError(await decline(h, minor.token), 400, "invalid_token");
    expect(await meStatus(h, minor.session.accessToken)).toBe("pending_consent");
  });

  it("an expired request shows as expired; resending gives a fresh 7-day link", async () => {
    const minor = await pendingMinor(h);
    h.clock.advance(CONSENT_LINK_MS + SECOND);
    expect((await getConsent(h, minor.session.accessToken)).state).toBe("expired");
    const response = await requestConsent(h, minor.session.accessToken);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().state).toBe("pending");
    expect((await confirm(h, consentToken(h, minor.guardian))).statusCode).toBe(200);
  });

  it("can be confirmed exactly at the last second before expiry", async () => {
    const minor = await pendingMinor(h);
    h.clock.advance(CONSENT_LINK_MS - SECOND);
    expect((await confirm(h, minor.token)).statusCode).toBe(200);
  });
});

describe("Tampered, unknown and wrong-purpose tokens", () => {
  function flipLast(token: string): string {
    const last = token.at(-1)!;
    return token.slice(0, -1) + (last === "A" ? "B" : "A");
  }

  it("rejects a tampered token, a random plc_ token and an unknown token identically", async () => {
    const minor = await pendingMinor(h);
    const bodies: string[] = [];
    for (const token of [
      flipLast(minor.token),
      `plc_${"A".repeat(43)}`,
      "not-a-token",
      minor.token.toUpperCase(),
      ` ${minor.token}x`,
    ]) {
      const r = await review(h, token);
      expectApiError(r, 400, "invalid_token");
      bodies.push(r.body);
      expectApiError(await confirm(h, token), 400, "invalid_token");
    }
    expect(new Set(bodies).size).toBe(1);
    expect((await confirm(h, minor.token)).statusCode).toBe(200);
  });

  it("used, expired and replaced links give the same error body as unknown ones", async () => {
    const used = await pendingMinor(h);
    await confirm(h, used.token);
    const replaced = await pendingMinor(h);
    await requestConsent(h, replaced.session.accessToken);
    const expired = await pendingMinor(h);
    h.clock.advance(CONSENT_LINK_MS + SECOND);

    const bodies = new Set<string>();
    for (const token of [used.token, replaced.token, expired.token, `plc_${"z".repeat(43)}`]) {
      const r = await review(h, token);
      expectApiError(r, 400, "invalid_token");
      bodies.add(r.body);
    }
    expect(bodies.size).toBe(1);
  });

  it("a verify-email token is not a consent token, and vice versa", async () => {
    const minor = await signUpMinor(h);
    const verifyToken = lastToken(h.mailer, minor.email, "verify_email");
    expectApiError(await review(h, verifyToken), 400, "invalid_token");
    expectApiError(await confirm(h, verifyToken), 400, "invalid_token");

    await verifyMember(h, minor.email);
    const token = consentToken(h, minor.guardian);
    expectApiError(await post(h.app, "/auth/verify-email", { token }), 400, "invalid_token");
    expectApiError(
      await post(h.app, "/auth/password-reset/confirm", { token, password: "hijack password 1" }),
      400,
      "invalid_token",
    );
    expect((await review(h, token)).statusCode).toBe(200);
  });

  it("rejects non-string tokens with 400 validation_error, never 500", async () => {
    for (const token of [undefined, null, 123, ["plc_x"], { $ne: "" }]) {
      expectApiError(await review(h, token), 400, "validation_error");
    }
  });
});

describe("Concurrent decisions", () => {
  it("confirm and decline at the same moment: exactly one wins, one decided record", async () => {
    const minor = await pendingMinor(h);
    const [a, b] = await Promise.all([confirm(h, minor.token), decline(h, minor.token)]);
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toEqual([200, 400]);
    const winner = (a.statusCode === 200 ? a : b).json().decision as string;
    const loser = a.statusCode === 200 ? b : a;
    expectApiError(loser, 400, "invalid_token");

    const rows = await consentRows(connection, minor.email);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe(winner === "confirm" ? "confirmed" : "declined");
    expect(await meStatus(h, minor.session.accessToken)).toBe(
      winner === "confirm" ? "active" : "pending_consent",
    );
  });

  it("ten simultaneous confirms: exactly one succeeds", async () => {
    const minor = await pendingMinor(h);
    const responses = await Promise.all(Array.from({ length: 10 }, () => confirm(h, minor.token)));
    expect(responses.filter((r) => r.statusCode === 200)).toHaveLength(1);
    for (const r of responses.filter((r) => r.statusCode !== 200)) {
      expectApiError(r, 400, "invalid_token");
    }
  });

  it("simultaneous resends leave exactly one live link", async () => {
    const minor = await pendingMinor(h);
    h.clock.advance(SECOND);
    const responses = await Promise.all(
      Array.from({ length: 4 }, () => requestConsent(h, minor.session.accessToken)),
    );
    for (const r of responses) expect(r.statusCode, r.body).toBe(200);
    const tokens = consentEmails(h, minor.guardian).map((m) => tokenFromLink(m.link!));
    const live: string[] = [];
    for (const token of tokens) if ((await review(h, token)).statusCode === 200) live.push(token);
    expect(live).toHaveLength(1);
    const rows = await consentRows(connection, minor.email);
    expect(rows.filter((r) => r.status === "pending")).toHaveLength(1);
  });

  it("confirming an old link while a resend happens never leaves two live links", async () => {
    const minor = await pendingMinor(h);
    await Promise.all([confirm(h, minor.token), requestConsent(h, minor.session.accessToken)]);
    const status = await meStatus(h, minor.session.accessToken);
    const rows = await consentRows(connection, minor.email);
    if (status === "active") {
      expect(rows.filter((r) => r.status === "confirmed")).toHaveLength(1);
      expect(rows.filter((r) => r.status === "pending")).toHaveLength(0);
    } else {
      expect(rows.filter((r) => r.status === "pending")).toHaveLength(1);
    }
  });
});

describe("AC4: the consent record is stored and auditable", () => {
  it("a confirmation records who, when, how, from where and the attestation", async () => {
    const minor = await pendingMinor(h, { dateOfBirth: "2011-07-09" });
    h.clock.advance(5 * 60 * SECOND);
    const decidedAt = h.clock.now();
    const response = await post(
      h.app,
      "/auth/consent/decision",
      { token: minor.token, decision: "confirm", isParentOrGuardian: true },
      { ip: "198.51.100.7", headers: { "user-agent": "QA-Guardian-Browser/1.0" } },
    );
    expect(response.statusCode, response.body).toBe(200);

    const rows = await consentRows(connection, minor.email);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toMatchObject({
      guardian_email: minor.guardian,
      dob_text: "2011-07-09",
      method: "email_link",
      status: "confirmed",
      decided_ip: "198.51.100.7",
      decided_user_agent: "QA-Guardian-Browser/1.0",
      guardian_attested: true,
      superseded_at: null,
    });
    expect(new Date(row.requested_at).toISOString()).toBe(FIXED_NOW);
    expect(new Date(row.expires_at).getTime()).toBe(Date.parse(FIXED_NOW) + CONSENT_LINK_MS);
    expect(new Date(row.decided_at!).toISOString()).toBe(decidedAt.toISOString());
  });

  it("stores only a SHA-256 hash of the link token, never the token", async () => {
    const minor = await pendingMinor(h);
    const [row] = await consentRows(connection, minor.email);
    const digest = createHash("sha256").update(minor.token).digest();
    expect([
      digest.toString("hex"),
      digest.toString("base64url"),
      digest.toString("base64"),
    ]).toContain(row!.token_hash);
    for (const value of Object.values(row!)) {
      if (typeof value === "string") expect(value).not.toContain(minor.token.slice(4));
    }
  });

  it("a decline is recorded with no attestation", async () => {
    const minor = await pendingMinor(h);
    await decline(h, minor.token);
    const [row] = await consentRows(connection, minor.email);
    expect(row).toMatchObject({ status: "declined", guardian_email: minor.guardian });
    expect(row!.guardian_attested).not.toBe(true);
    expect(row!.decided_at).not.toBeNull();
  });

  it("resends, guardian changes and declines are all kept (history is never lost)", async () => {
    const minor = await pendingMinor(h);
    h.clock.advance(SECOND);
    await requestConsent(h, minor.session.accessToken); // supersedes #1
    h.clock.advance(SECOND);
    await decline(h, consentToken(h, minor.guardian)); // #2 declined
    h.clock.advance(SECOND);
    const other = guardianEmail();
    await requestConsent(h, minor.session.accessToken, { guardianEmail: other }); // #3
    h.clock.advance(SECOND);
    await confirm(h, consentToken(h, other)); // #3 confirmed

    const rows = await consentRows(connection, minor.email);
    expect(rows.map((r) => [r.guardian_email, r.status])).toEqual([
      [minor.guardian, "superseded"],
      [minor.guardian, "declined"],
      [other, "confirmed"],
    ]);
    expect(rows[0]!.superseded_at).not.toBeNull();
  });

  it("a member with consent records cannot be deleted by accident (foreign key restricts)", async () => {
    const minor = await pendingMinor(h);
    await expect(
      connection.db.execute(sql`delete from users where email = ${minor.email}`),
    ).rejects.toThrow();
    expect(await consentRows(connection, minor.email)).toHaveLength(1);
  });
});

describe("Other accounts are unaffected", () => {
  it("adults: sign-up, verify and login work as in #1 and no consent email is sent", async () => {
    const adult = await activeMember(h);
    expect(adult.session.user.status).toBe("active");
    expect((await getConsent(h, adult.session.accessToken)).state).toBe("not_required");
    expect(consentEmails(h)).toHaveLength(0);
  });

  it("a guardian who has their own account can consent; their account is unchanged", async () => {
    const parent = await activeMember(h);
    const minor = await pendingMinor(h, { guardian: parent.email });
    expect((await confirm(h, minor.token)).statusCode).toBe(200);
    expect(await meStatus(h, parent.session.accessToken)).toBe("active");
    expect(await meStatus(h, minor.session.accessToken)).toBe("active");
  });

  it("one guardian for two siblings: each link only affects its own member", async () => {
    const g = guardianEmail();
    const first = await pendingMinor(h, { guardian: g });
    const firstToken = first.token;
    h.clock.advance(SECOND);
    const second = await pendingMinor(h, { guardian: g });
    expect((await confirm(h, firstToken)).statusCode).toBe(200);
    expect(await meStatus(h, first.session.accessToken)).toBe("active");
    expect(await meStatus(h, second.session.accessToken)).toBe("pending_consent");
    expect((await decline(h, second.token)).statusCode).toBe(200);
    expect(await meStatus(h, first.session.accessToken)).toBe("active");
  });

  it("the member's password still works after consent; logout and refresh unchanged", async () => {
    const minor = await pendingMinor(h);
    await confirm(h, minor.token);
    const refreshed = await post(h.app, "/auth/refresh", {
      refreshToken: minor.session.refreshToken,
    });
    expect(refreshed.statusCode, refreshed.body).toBe(200);
    expect(refreshed.json().user.status).toBe("active");
    expect(
      (await post(h.app, "/auth/login", { email: minor.email, password: PASSWORD })).statusCode,
    ).toBe(200);
  });
});
