/**
 * QA (issue #3): rate limits and abuse cases for guardian consent
 * (docs/api/consent.md, "Rate limits (added)").
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseConnection } from "../src/db/client.js";
import {
  expectApiError,
  type Harness,
  HOUR,
  logIn,
  openTestDatabase,
  type RateLimitOverrides,
} from "./support/auth-harness.js";
import {
  consentEmails,
  getConsent,
  guardianEmail,
  makeConsentHarness,
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
afterEach(async () => {
  await h?.app.close();
});

/** Defaults for everything, generous for rules not under test, tight for `rules`. */
async function harness(rules: Record<string, { max: number; windowMs: number }>) {
  const generous = { max: 10_000, windowMs: HOUR };
  h = await makeConsentHarness(connection, {
    rateLimits: {
      signupPerIp: generous,
      emailRequestsPerIp: generous,
      emailRequestsPerEmail: generous,
      tokenAttemptsPerIp: generous,
      loginPerIp: generous,
      consentRequestsPerAccount: generous,
      consentEmailsPerGuardian: generous,
      ...rules,
    } as RateLimitOverrides,
  });
}

function expectRateLimited(response: Awaited<ReturnType<typeof review>>) {
  expectApiError(response, 429, "rate_limited");
  expect(Number(response.headers["retry-after"])).toBeGreaterThan(0);
}

describe("consentRequestsPerAccount", () => {
  it("limits resends per member account; another member is unaffected", async () => {
    await harness({ consentRequestsPerAccount: { max: 2, windowMs: HOUR } });
    const minor = await pendingMinor(h);
    for (let i = 0; i < 2; i++) {
      const r = await requestConsent(h, minor.session.accessToken);
      expect(r.statusCode, r.body).toBe(200);
    }
    expectRateLimited(await requestConsent(h, minor.session.accessToken));
    // Changing the guardian counts too: no way round the limit.
    expectRateLimited(
      await requestConsent(h, minor.session.accessToken, { guardianEmail: guardianEmail() }),
    );
    // A different IP does not reset a per-account limit.
    expectRateLimited(
      await requestConsent(h, minor.session.accessToken, {}, { ip: "198.51.100.99" }),
    );
    const other = await pendingMinor(h);
    expect((await requestConsent(h, other.session.accessToken)).statusCode).toBe(200);
    // Window passes: allowed again.
    h.clock.advance(HOUR + 1000);
    expect((await requestConsent(h, minor.session.accessToken)).statusCode).toBe(200);
  });

  it("the default is 5 per hour", async () => {
    h = await makeConsentHarness(connection, { rateLimits: "defaults" });
    const minor = await pendingMinor(h);
    for (let i = 0; i < 5; i++) {
      const r = await requestConsent(h, minor.session.accessToken);
      expect(r.statusCode, `request ${i + 1}: ${r.body}`).toBe(200);
    }
    expectRateLimited(await requestConsent(h, minor.session.accessToken));
  });
});

describe("consentEmailsPerGuardian", () => {
  it("limits emails to one guardian across members; verification still succeeds (not_sent)", async () => {
    await harness({ consentEmailsPerGuardian: { max: 2, windowMs: HOUR } });
    const g = guardianEmail();
    await pendingMinor(h, { guardian: g });
    await pendingMinor(h, { guardian: g });
    expect(consentEmails(h, g)).toHaveLength(2);

    const third = await signUpMinor(h, { guardian: g });
    const verified = await verifyMember(h, third.email);
    expect(verified.accountStatus).toBe("pending_consent");
    expect(consentEmails(h, g)).toHaveLength(2);
    const session = await logIn(h, third.email);
    expect((await getConsent(h, session.accessToken)).state).toBe("not_sent");
    expectRateLimited(await requestConsent(h, session.accessToken));

    h.clock.advance(HOUR + 1000);
    const r = await requestConsent(h, session.accessToken);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().state).toBe("pending");
    expect(consentEmails(h, g)).toHaveLength(3);
  });

  it("counts the guardian address case-insensitively", async () => {
    await harness({ consentEmailsPerGuardian: { max: 1, windowMs: HOUR } });
    const g = guardianEmail();
    await pendingMinor(h, { guardian: g });
    const second = await signUpMinor(h, { guardian: g.toUpperCase() });
    await verifyMember(h, second.email);
    expect(consentEmails(h, g)).toHaveLength(1);
  });
});

describe("tokenAttemptsPerIp and emailRequestsPerIp", () => {
  it("consent review and decision attempts count towards tokenAttemptsPerIp", async () => {
    await harness({ tokenAttemptsPerIp: { max: 3, windowMs: 15 * 60 * 1000 } });
    const ip = "192.0.2.50";
    for (let i = 0; i < 3; i++) {
      expectApiError(await review(h, `plc_guess_${i}`, { ip }), 400, "invalid_token");
    }
    expectRateLimited(await review(h, "plc_guess_4", { ip }));
    expectRateLimited(
      await h.app.inject({
        method: "POST",
        url: "/auth/consent/decision",
        remoteAddress: ip,
        payload: { token: "plc_guess_5", decision: "decline" },
      }),
    );
    expectApiError(await review(h, "plc_guess_6", { ip: "192.0.2.51" }), 400, "invalid_token");
  });

  it("consent requests count towards emailRequestsPerIp", async () => {
    await harness({ emailRequestsPerIp: { max: 2, windowMs: HOUR } });
    const ip = "192.0.2.60";
    const minor = await pendingMinor(h);
    for (let i = 0; i < 2; i++) {
      const r = await requestConsent(h, minor.session.accessToken, {}, { ip });
      expect(r.statusCode, r.body).toBe(200);
    }
    expectRateLimited(await requestConsent(h, minor.session.accessToken, {}, { ip }));
  });
});
