/**
 * QA (issue #1), AC5: brute-force protection (rate limits with the documented
 * defaults) and no account enumeration (status, body and timing).
 */
import type { LightMyRequestResponse } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseConnection } from "../src/db/client.js";
import {
  activeMember,
  expectApiError,
  type Harness,
  makeHarness,
  MINUTE,
  openTestDatabase,
  PASSWORD,
  post,
  signUp,
  uniqueEmail,
} from "./support/auth-harness.js";

let connection: DatabaseConnection;
const open: Harness[] = [];

beforeAll(async () => {
  connection = await openTestDatabase();
});
afterAll(async () => {
  await connection?.pool.end();
});
afterEach(async () => {
  await Promise.all(open.splice(0).map((x) => x.app.close()));
});

/** A harness with the documented default rate limits. */
async function withDefaults() {
  const harness = await makeHarness(connection, { rateLimits: "defaults" });
  open.push(harness);
  return harness;
}
async function withoutLimits() {
  const harness = await makeHarness(connection);
  open.push(harness);
  return harness;
}

let ipCounter = 0;
/** A fresh client IP per call site, so per-IP counters don't leak between tests. */
const freshIp = () => `198.51.100.${(ipCounter++ % 250) + 1}`;

function expectRateLimited(response: LightMyRequestResponse) {
  expectApiError(response, 429, "rate_limited");
  const retryAfter = Number(response.headers["retry-after"]);
  expect(
    Number.isInteger(retryAfter) && retryAfter > 0,
    `Retry-After: ${response.headers["retry-after"]}`,
  ).toBe(true);
}

const WRONG = "definitely wrong pw";

describe("login: failures per email (5 per 15 minutes)", () => {
  it("allows 5 failures, then 429 even with the right password and from other IPs", async () => {
    const h = await withDefaults();
    const { email } = await activeMember(h);

    for (let i = 0; i < 5; i++) {
      expectApiError(
        await post(h.app, "/auth/login", { email, password: WRONG }, { ip: freshIp() }),
        401,
        "invalid_credentials",
      );
    }
    expectRateLimited(
      await post(h.app, "/auth/login", { email, password: WRONG }, { ip: freshIp() }),
    );
    // Locked: the correct password is no oracle.
    expectRateLimited(
      await post(h.app, "/auth/login", { email, password: PASSWORD }, { ip: freshIp() }),
    );
  });

  it("counts by normalised email (case / whitespace variants share one counter)", async () => {
    const h = await withDefaults();
    const { email } = await activeMember(h);
    const variants = [email, email.toUpperCase(), ` ${email}`, `${email} `, email.toUpperCase()];
    for (const v of variants) {
      expect(
        (await post(h.app, "/auth/login", { email: v, password: WRONG }, { ip: freshIp() }))
          .statusCode,
      ).toBe(401);
    }
    expectRateLimited(
      await post(h.app, "/auth/login", { email, password: PASSWORD }, { ip: freshIp() }),
    );
  });

  it("limits an unknown email exactly like a registered one (no enumeration via 429)", async () => {
    const h = await withDefaults();
    const known = (await activeMember(h)).email;
    const unknown = uniqueEmail("nobody");
    const sequence = async (email: string) => {
      const codes: number[] = [];
      for (let i = 0; i < 7; i++) {
        codes.push(
          (await post(h.app, "/auth/login", { email, password: WRONG }, { ip: freshIp() }))
            .statusCode,
        );
      }
      return codes;
    };
    expect(await sequence(unknown)).toEqual(await sequence(known));
  });

  it("a successful login resets the failure counter", async () => {
    const h = await withDefaults();
    const { email } = await activeMember(h);
    for (let i = 0; i < 4; i++)
      await post(h.app, "/auth/login", { email, password: WRONG }, { ip: freshIp() });
    expect(
      (await post(h.app, "/auth/login", { email, password: PASSWORD }, { ip: freshIp() }))
        .statusCode,
    ).toBe(200);
    for (let i = 0; i < 4; i++) {
      expect(
        (await post(h.app, "/auth/login", { email, password: WRONG }, { ip: freshIp() }))
          .statusCode,
      ).toBe(401);
    }
  });

  it("unlocks after the 15-minute window", async () => {
    const h = await withDefaults();
    const { email } = await activeMember(h);
    for (let i = 0; i < 6; i++)
      await post(h.app, "/auth/login", { email, password: WRONG }, { ip: freshIp() });
    expectRateLimited(
      await post(h.app, "/auth/login", { email, password: PASSWORD }, { ip: freshIp() }),
    );

    h.clock.advance(15 * MINUTE + 1_000);
    expect(
      (await post(h.app, "/auth/login", { email, password: PASSWORD }, { ip: freshIp() }))
        .statusCode,
    ).toBe(200);
  });

  it("other accounts are not affected by one account's lockout", async () => {
    const h = await withDefaults();
    const victim = await activeMember(h);
    const other = await activeMember(h);
    for (let i = 0; i < 6; i++)
      await post(h.app, "/auth/login", { email: victim.email, password: WRONG }, { ip: freshIp() });
    expect(
      (
        await post(
          h.app,
          "/auth/login",
          { email: other.email, password: PASSWORD },
          { ip: freshIp() },
        )
      ).statusCode,
    ).toBe(200);
  });
});

describe("login: per IP (30 per 15 minutes)", () => {
  it("allows 30 logins from one IP, then 429; another IP is unaffected", async () => {
    const h = await withDefaults();
    const ip = freshIp();
    for (let i = 0; i < 30; i++) {
      const r = await post(
        h.app,
        "/auth/login",
        { email: uniqueEmail("spray"), password: WRONG },
        { ip },
      );
      expect(r.statusCode, `attempt ${i + 1}`).toBe(401);
    }
    expectRateLimited(
      await post(h.app, "/auth/login", { email: uniqueEmail("spray"), password: WRONG }, { ip }),
    );
    const { email } = await activeMember(h);
    expect(
      (await post(h.app, "/auth/login", { email, password: PASSWORD }, { ip: freshIp() }))
        .statusCode,
    ).toBe(200);
  });

  it("ignores a spoofed X-Forwarded-For header (unless a proxy is configured)", async () => {
    const h = await withDefaults();
    const ip = freshIp();
    let limited = false;
    for (let i = 0; i < 31 && !limited; i++) {
      const r = await post(
        h.app,
        "/auth/login",
        { email: uniqueEmail("spray"), password: WRONG },
        { ip, headers: { "x-forwarded-for": `10.0.${i}.1` } },
      );
      limited = r.statusCode === 429;
    }
    expect(limited, "rotating X-Forwarded-For bypassed the per-IP limit").toBe(true);
  });
});

describe("sign-up per IP (10 per hour)", () => {
  it("allows 10 sign-ups from one IP, then 429", async () => {
    const h = await withDefaults();
    const ip = freshIp();
    for (let i = 0; i < 10; i++) {
      expect(
        (await post(h.app, "/auth/signup", { email: uniqueEmail(), password: PASSWORD }, { ip }))
          .statusCode,
      ).toBe(202);
    }
    expectRateLimited(
      await post(h.app, "/auth/signup", { email: uniqueEmail(), password: PASSWORD }, { ip }),
    );
  });
});

describe("email requests (resend verification + reset request)", () => {
  it("per email: 3 per hour across both endpoints, then 429, for known and unknown emails alike", async () => {
    const h = await withDefaults();
    const known = uniqueEmail();
    await signUp(h, known, PASSWORD, { ip: freshIp() });
    const unknown = uniqueEmail("nobody");

    for (const email of [known, unknown]) {
      const codes = [
        (await post(h.app, "/auth/verify-email/resend", { email }, { ip: freshIp() })).statusCode,
        (await post(h.app, "/auth/password-reset/request", { email }, { ip: freshIp() }))
          .statusCode,
        (await post(h.app, "/auth/verify-email/resend", { email }, { ip: freshIp() })).statusCode,
      ];
      expect(codes, email).toEqual([202, 202, 202]);
      expectRateLimited(
        await post(h.app, "/auth/password-reset/request", { email }, { ip: freshIp() }),
      );
    }
  });

  it("per email limit stops the mailbox being flooded (no more emails after the limit)", async () => {
    const h = await withDefaults();
    const { email } = await activeMember(h);
    h.mailer.clear();
    for (let i = 0; i < 6; i++)
      await post(h.app, "/auth/password-reset/request", { email }, { ip: freshIp() });
    expect(h.mailer.messages.filter((m) => m.to === email)).toHaveLength(3);
  });

  it("per IP: 20 per hour, then 429", async () => {
    const h = await withDefaults();
    const ip = freshIp();
    for (let i = 0; i < 20; i++) {
      const url = i % 2 ? "/auth/verify-email/resend" : "/auth/password-reset/request";
      expect(
        (await post(h.app, url, { email: uniqueEmail("flood") }, { ip })).statusCode,
        `request ${i + 1}`,
      ).toBe(202);
    }
    expectRateLimited(
      await post(h.app, "/auth/password-reset/request", { email: uniqueEmail("flood") }, { ip }),
    );
  });
});

describe("token attempts per IP (20 per 15 minutes)", () => {
  it("allows 20 verify / reset-confirm attempts from one IP, then 429", async () => {
    const h = await withDefaults();
    const ip = freshIp();
    for (let i = 0; i < 20; i++) {
      const r =
        i % 2
          ? await post(h.app, "/auth/verify-email", { token: `guess-${i}` }, { ip })
          : await post(
              h.app,
              "/auth/password-reset/confirm",
              { token: `guess-${i}`, password: PASSWORD },
              { ip },
            );
      expect(r.statusCode, `attempt ${i + 1}`).toBe(400);
    }
    expectRateLimited(await post(h.app, "/auth/verify-email", { token: "guess-x" }, { ip }));
  });
});

describe("no account enumeration", () => {
  it("sign-up: identical status, body and content-type for new, unverified and verified emails", async () => {
    const h = await withoutLimits();
    const unverified = uniqueEmail();
    await signUp(h, unverified);
    const { email: verified } = await activeMember(h);

    const responses = await Promise.all(
      [uniqueEmail("new"), unverified, verified].map((email) =>
        post(h.app, "/auth/signup", { email, password: PASSWORD }),
      ),
    );
    expect(responses.map((r) => r.statusCode)).toEqual([202, 202, 202]);
    expect(new Set(responses.map((r) => r.body)).size).toBe(1);
    expect(new Set(responses.map((r) => r.headers["content-type"])).size).toBe(1);
  });

  it("login: unknown email takes about as long as a wrong password (dummy hash)", async () => {
    const h = await withoutLimits();
    const { email } = await activeMember(h);
    const time = async (body: object) => {
      const started = performance.now();
      await post(h.app, "/auth/login", body);
      return performance.now() - started;
    };
    const median = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
    const known: number[] = [];
    const unknown: number[] = [];
    for (let i = 0; i < 9; i++) {
      known.push(await time({ email, password: WRONG }));
      unknown.push(await time({ email: uniqueEmail("nobody"), password: WRONG }));
    }
    const ratio = median(unknown) / median(known);
    expect(
      ratio,
      `unknown ${median(unknown).toFixed(1)}ms vs known ${median(known).toFixed(1)}ms`,
    ).toBeGreaterThan(0.5);
    expect(ratio).toBeLessThan(2);
  });

  it("password-reset request: unknown email takes about as long as a known one", async () => {
    const h = await withoutLimits();
    const { email } = await activeMember(h);
    const time = async (e: string) => {
      const started = performance.now();
      await post(h.app, "/auth/password-reset/request", { email: e });
      return performance.now() - started;
    };
    const median = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
    const known: number[] = [];
    const unknown: number[] = [];
    for (let i = 0; i < 9; i++) {
      known.push(await time(email));
      unknown.push(await time(uniqueEmail("nobody")));
    }
    // Generous bound: catches an email send or extra DB work that only happens for known emails
    // when it is slow (e.g. a real provider call made inline).
    const diff = median(known) - median(unknown);
    expect(
      diff,
      `known ${median(known).toFixed(1)}ms vs unknown ${median(unknown).toFixed(1)}ms`,
    ).toBeLessThan(50);
  });
});
