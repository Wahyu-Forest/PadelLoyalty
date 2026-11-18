/**
 * #1 AC: "Login is protected against brute force (rate limiting) and doesn't
 * reveal whether an email is registered". Uses the default limits.
 */
import { apiErrorResponseSchema } from "@padelloyalty/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_RATE_LIMITS } from "../src/auth/rate-limit.js";
import type { DatabaseConnection } from "../src/db/client.js";
import {
  PASSWORD,
  buildAuthApp,
  connectTestDatabase,
  resetAuthTables,
  type TestApp,
} from "./support/auth-app.js";

let connection: DatabaseConnection;
let t: TestApp;
const EMAIL = "ana@example.com";
const MINUTE = 60_000;

beforeAll(async () => {
  connection = await connectTestDatabase();
});
afterAll(async () => {
  await connection?.pool.end();
});
beforeEach(async () => {
  await resetAuthTables(connection);
  t = await buildAuthApp(connection);
});
afterEach(async () => {
  await t.app.close();
});

const fromIp = (ip: string) => ({ "x-forwarded-for": ip });

async function failLogins(email: string, times: number) {
  for (let i = 0; i < times; i++) {
    const response = await t.post("/auth/login", { email, password: `wrong ${i}` });
    expect(response.statusCode).toBe(401);
  }
}

describe("login brute-force protection", () => {
  it("blocks an email after 5 failed attempts, even with the right password", async () => {
    await t.signUpVerified(EMAIL);
    await failLogins(EMAIL, DEFAULT_RATE_LIMITS.loginFailuresPerEmail.max);

    const blocked = await t.post("/auth/login", { email: EMAIL, password: PASSWORD });

    expect(blocked.statusCode).toBe(429);
    expect(apiErrorResponseSchema.parse(blocked.json()).error.code).toBe("rate_limited");
    const retryAfter = Number(blocked.headers["retry-after"]);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(15 * 60);
  });

  it("unblocks after the 15-minute window", async () => {
    await t.signUpVerified(EMAIL);
    await failLogins(EMAIL, DEFAULT_RATE_LIMITS.loginFailuresPerEmail.max);
    t.clock.advance(15 * MINUTE);

    expect((await t.post("/auth/login", { email: EMAIL, password: PASSWORD })).statusCode).toBe(
      200,
    );
  });

  it("limits unknown emails exactly like registered ones (no enumeration)", async () => {
    await t.signUpVerified(EMAIL);
    await failLogins(EMAIL, DEFAULT_RATE_LIMITS.loginFailuresPerEmail.max);
    await failLogins("nobody@example.com", DEFAULT_RATE_LIMITS.loginFailuresPerEmail.max);

    const known = await t.post("/auth/login", { email: EMAIL, password: "x" });
    const unknown = await t.post("/auth/login", { email: "nobody@example.com", password: "x" });

    expect(known.statusCode).toBe(429);
    expect(unknown.statusCode).toBe(429);
    expect(unknown.json()).toEqual(known.json());
  });

  it("resets the failure count after a successful login", async () => {
    await t.signUpVerified(EMAIL);
    await failLogins(EMAIL, DEFAULT_RATE_LIMITS.loginFailuresPerEmail.max - 1);
    expect((await t.post("/auth/login", { email: EMAIL, password: PASSWORD })).statusCode).toBe(
      200,
    );

    await failLogins(EMAIL, DEFAULT_RATE_LIMITS.loginFailuresPerEmail.max - 1);
    expect((await t.post("/auth/login", { email: EMAIL, password: PASSWORD })).statusCode).toBe(
      200,
    );
  });

  it("does not block other emails", async () => {
    await t.signUpVerified(EMAIL);
    await t.signUpVerified("bea@example.com");
    await failLogins(EMAIL, DEFAULT_RATE_LIMITS.loginFailuresPerEmail.max);

    expect(
      (await t.post("/auth/login", { email: "bea@example.com", password: PASSWORD })).statusCode,
    ).toBe(200);
  });

  it("caps login attempts per IP across many emails", async () => {
    await t.app.close();
    t = await buildAuthApp(connection, {
      rateLimits: { loginPerIp: { max: 3, windowMs: MINUTE } },
    });
    for (let i = 0; i < 3; i++) {
      await t.post("/auth/login", { email: `user${i}@example.com`, password: "x" });
    }

    const blocked = await t.post("/auth/login", { email: "other@example.com", password: "x" });

    expect(blocked.statusCode).toBe(429);
  });
});

describe("email request limits", () => {
  it("limits password-reset requests per email, the same for unknown emails", async () => {
    await t.signUpVerified(EMAIL);
    const max = DEFAULT_RATE_LIMITS.emailRequestsPerEmail.max;
    for (let i = 0; i < max; i++) {
      expect((await t.post("/auth/password-reset/request", { email: EMAIL })).statusCode).toBe(202);
      expect(
        (await t.post("/auth/password-reset/request", { email: "nobody@example.com" })).statusCode,
      ).toBe(202);
    }

    const known = await t.post("/auth/password-reset/request", { email: EMAIL });
    const unknown = await t.post("/auth/password-reset/request", { email: "nobody@example.com" });

    expect(known.statusCode).toBe(429);
    expect(unknown.statusCode).toBe(429);
    expect(unknown.json()).toEqual(known.json());
  });

  it("does not let repeated sign-ups flood a registered address", async () => {
    await t.signUpVerified(EMAIL);
    t.mailer.clear();

    for (let i = 0; i < 6; i++) {
      expect((await t.post("/auth/signup", { email: EMAIL, password: PASSWORD })).statusCode).toBe(
        202,
      );
    }

    expect(t.mailer.messages.length).toBe(DEFAULT_RATE_LIMITS.emailRequestsPerEmail.max);
  });

  it("limits link-token guesses per IP", async () => {
    const max = DEFAULT_RATE_LIMITS.tokenAttemptsPerIp.max;
    for (let i = 0; i < max; i++) {
      expect((await t.post("/auth/verify-email", { token: `ple_guess${i}` })).statusCode).toBe(400);
    }

    expect((await t.post("/auth/verify-email", { token: "ple_guess" })).statusCode).toBe(429);
  });

  it("limits sign-ups per IP", async () => {
    const max = DEFAULT_RATE_LIMITS.signupPerIp.max;
    for (let i = 0; i < max; i++) {
      expect(
        (await t.post("/auth/signup", { email: `u${i}@example.com`, password: PASSWORD }))
          .statusCode,
      ).toBe(202);
    }

    expect(
      (await t.post("/auth/signup", { email: "one-more@example.com", password: PASSWORD }))
        .statusCode,
    ).toBe(429);
  });
});

describe("configuration", () => {
  it("can be disabled for tests with rateLimits: false", async () => {
    await t.app.close();
    t = await buildAuthApp(connection, { rateLimits: false });
    await failLogins(EMAIL, 10);
  });

  it("ignores X-Forwarded-For unless trustProxy is on (clients cannot dodge per-IP limits)", async () => {
    await t.app.close();
    t = await buildAuthApp(connection, {
      rateLimits: { loginPerIp: { max: 1, windowMs: MINUTE } },
    });
    await t.post("/auth/login", { email: "a@example.com", password: "x" }, fromIp("1.1.1.1"));

    const second = await t.post(
      "/auth/login",
      { email: "b@example.com", password: "x" },
      fromIp("2.2.2.2"),
    );

    expect(second.statusCode).toBe(429);
  });
});
