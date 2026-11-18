/**
 * QA (issue #1), AC3 and AC6: log in, access token, refresh-token rotation and
 * reuse detection, log out, multiple devices, CORS for the app origins.
 */
import { meResponseSchema } from "@padelloyalty/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseConnection } from "../src/db/client.js";
import {
  activeMember,
  DAY,
  expectApiError,
  expectSession,
  getMe,
  type Harness,
  logIn,
  makeHarness,
  MINUTE,
  openTestDatabase,
  PASSWORD,
  post,
  SECOND,
  signUp,
  uniqueEmail,
} from "./support/auth-harness.js";

let connection: DatabaseConnection;
let h: Harness;

beforeAll(async () => {
  connection = await openTestDatabase();
});
afterAll(async () => {
  await connection?.pool.end();
});
beforeEach(async () => {
  h = await makeHarness(connection);
});
afterEach(async () => {
  await h.app.close();
});

const refresh = (refreshToken: string) => post(h.app, "/auth/refresh", { refreshToken });
const logout = (refreshToken: unknown) => post(h.app, "/auth/logout", { refreshToken });

describe("POST /auth/login", () => {
  it("returns a session with 15-minute access and 30-day refresh expiry", async () => {
    const { session } = await activeMember(h);
    const now = h.clock.now().getTime();
    const accessIn = Date.parse(session.accessTokenExpiresAt) - now;
    const refreshIn = Date.parse(session.refreshTokenExpiresAt) - now;

    expect(accessIn).toBeGreaterThan(15 * MINUTE - 5 * SECOND);
    expect(accessIn).toBeLessThanOrEqual(15 * MINUTE + 5 * SECOND);
    expect(refreshIn).toBeGreaterThan(30 * DAY - MINUTE);
    expect(refreshIn).toBeLessThanOrEqual(30 * DAY + MINUTE);
    expect(session.accessToken).not.toBe(session.refreshToken);
  });

  it("rejects a wrong password with 401 invalid_credentials", async () => {
    const { email } = await activeMember(h);
    expectApiError(
      await post(h.app, "/auth/login", { email, password: "wrong password!!" }),
      401,
      "invalid_credentials",
    );
  });

  it("gives the same response for an unknown email, a wrong password and an unverified account", async () => {
    const { email } = await activeMember(h);
    const unverified = uniqueEmail();
    await signUp(h, unverified);

    const responses = await Promise.all([
      post(h.app, "/auth/login", { email: uniqueEmail("nobody"), password: "wrong password!!" }),
      post(h.app, "/auth/login", { email, password: "wrong password!!" }),
      post(h.app, "/auth/login", { email: unverified, password: "wrong password!!" }),
    ]);
    for (const r of responses) expectApiError(r, 401, "invalid_credentials");
    expect(new Set(responses.map((r) => r.body)).size).toBe(1);
  });

  it("validates the body", async () => {
    for (const body of [
      {},
      { email: "a@example.com" },
      { email: "nope", password: "x" },
      { email: "a@example.com", password: "" },
    ]) {
      expectApiError(await post(h.app, "/auth/login", body), 400, "validation_error");
    }
  });

  it("logs in with any casing of the email", async () => {
    const { email, password } = await activeMember(h);
    expectSession(await post(h.app, "/auth/login", { email: email.toUpperCase(), password }));
  });
});

describe("GET /auth/me", () => {
  it("returns the user for a valid access token, without any secret", async () => {
    const { email, session } = await activeMember(h);
    const response = await getMe(h.app, session.accessToken);

    expect(response.statusCode).toBe(200);
    const { user } = meResponseSchema.parse(response.json());
    expect(user).toEqual(session.user);
    expect(user.email).toBe(email);
    expect(response.body).not.toMatch(/password|hash|refreshToken/i);
  });

  it.each([
    ["no Authorization header", undefined],
    ["an empty bearer", ""],
    ["a random token", "not-a-real-token"],
  ])("401 unauthorized with %s", async (_name, token) => {
    expectApiError(await getMe(h.app, token), 401, "unauthorized");
  });

  it("401 for a tampered access token", async () => {
    const { session } = await activeMember(h);
    const t = session.accessToken;
    const tampered = t.slice(0, -2) + (t.endsWith("AA") ? "BB" : "AA");
    expectApiError(await getMe(h.app, tampered), 401, "unauthorized");
  });

  it("401 for a non-Bearer scheme", async () => {
    const { session } = await activeMember(h);
    const response = await h.app.inject({
      method: "GET",
      url: "/auth/me",
      headers: { authorization: `Basic ${session.accessToken}` },
    });
    expectApiError(response, 401, "unauthorized");
  });

  it("401 when the refresh token is used as an access token", async () => {
    const { session } = await activeMember(h);
    expectApiError(await getMe(h.app, session.refreshToken), 401, "unauthorized");
  });

  it("the access token works until 15 minutes and is 401 after", async () => {
    const { session } = await activeMember(h);
    h.clock.advance(15 * MINUTE - 10 * SECOND);
    expect((await getMe(h.app, session.accessToken)).statusCode).toBe(200);
    h.clock.advance(20 * SECOND);
    expectApiError(await getMe(h.app, session.accessToken), 401, "unauthorized");
  });
});

describe("POST /auth/refresh", () => {
  it("rotates: returns new tokens and the old refresh token stops working", async () => {
    const { session } = await activeMember(h);
    const next = expectSession(await refresh(session.refreshToken));

    expect(next.refreshToken).not.toBe(session.refreshToken);
    expect(next.accessToken).not.toBe(session.accessToken);
    expect(next.user.id).toBe(session.user.id);
    expect((await getMe(h.app, next.accessToken)).statusCode).toBe(200);
  });

  it("reuse of a rotated refresh token revokes the whole session", async () => {
    const { session } = await activeMember(h);
    const next = expectSession(await refresh(session.refreshToken));

    expectApiError(await refresh(session.refreshToken), 401, "invalid_refresh_token");
    // The legitimate latest tokens are revoked too.
    expectApiError(await refresh(next.refreshToken), 401, "invalid_refresh_token");
    expectApiError(await getMe(h.app, next.accessToken), 401, "unauthorized");
  });

  it("reuse detection does not affect the member's other sessions", async () => {
    const { email, session } = await activeMember(h);
    const other = await logIn(h, email);
    await refresh(session.refreshToken);
    await refresh(session.refreshToken); // reuse: revokes the first session only

    expect((await getMe(h.app, other.accessToken)).statusCode).toBe(200);
    expectSession(await refresh(other.refreshToken));
  });

  it("concurrent refreshes with one token: at most one succeeds and nothing 500s", async () => {
    const { session } = await activeMember(h);
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => refresh(session.refreshToken)),
    );
    const codes = responses.map((r) => r.statusCode);
    expect(codes.filter((c) => c === 200).length).toBeLessThanOrEqual(1);
    expect(
      codes.every((c) => c === 200 || c === 401),
      codes.join(","),
    ).toBe(true);
  });

  it("works after the access token has expired (silent refresh)", async () => {
    const { session } = await activeMember(h);
    h.clock.advance(20 * MINUTE);
    const next = expectSession(await refresh(session.refreshToken));
    expect((await getMe(h.app, next.accessToken)).statusCode).toBe(200);
  });

  it("refresh token expires after 30 days without use", async () => {
    const { session } = await activeMember(h);
    h.clock.advance(30 * DAY + MINUTE);
    expectApiError(await refresh(session.refreshToken), 401, "invalid_refresh_token");
  });

  it("is sliding: each refresh renews the 30 days", async () => {
    const { session } = await activeMember(h);
    h.clock.advance(20 * DAY);
    const second = expectSession(await refresh(session.refreshToken));
    h.clock.advance(20 * DAY); // 40 days after login, 20 after the last refresh
    const third = expectSession(await refresh(second.refreshToken));
    expect(Date.parse(third.refreshTokenExpiresAt)).toBeGreaterThan(
      h.clock.now().getTime() + 29 * DAY,
    );
  });

  it("rejects unknown, tampered and access tokens with 401 invalid_refresh_token", async () => {
    const { session } = await activeMember(h);
    const r = session.refreshToken;
    for (const bad of [
      "plr_unknown",
      r.slice(0, -2) + (r.endsWith("AA") ? "BB" : "AA"),
      session.accessToken,
    ]) {
      expectApiError(await refresh(bad), 401, "invalid_refresh_token");
    }
    // The real token is unaffected by the bad attempts.
    expectSession(await refresh(r));
  });

  it("validates the body", async () => {
    for (const body of [{}, { refreshToken: "" }, { refreshToken: "x".repeat(513) }]) {
      expectApiError(await post(h.app, "/auth/refresh", body), 400, "validation_error");
    }
  });
});

describe("POST /auth/logout", () => {
  it("revokes the session's refresh and access tokens at once", async () => {
    const { session } = await activeMember(h);
    const response = await logout(session.refreshToken);

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe("");
    expectApiError(await refresh(session.refreshToken), 401, "invalid_refresh_token");
    expectApiError(await getMe(h.app, session.accessToken), 401, "unauthorized");
  });

  it("revokes the session after a refresh too (logout with the latest token)", async () => {
    const { session } = await activeMember(h);
    const next = expectSession(await refresh(session.refreshToken));
    expect((await logout(next.refreshToken)).statusCode).toBe(204);
    expectApiError(await getMe(h.app, next.accessToken), 401, "unauthorized");
  });

  it("is idempotent and answers 204 for unknown tokens", async () => {
    const { session } = await activeMember(h);
    expect((await logout(session.refreshToken)).statusCode).toBe(204);
    expect((await logout(session.refreshToken)).statusCode).toBe(204);
    expect((await logout("plr_does_not_exist")).statusCode).toBe(204);
  });

  it("only logs out that device", async () => {
    const { email, password } = await activeMember(h);
    const web = await logIn(h, email, password);
    const phone = await logIn(h, email, password);
    await logout(web.refreshToken);

    expect((await getMe(h.app, phone.accessToken)).statusCode).toBe(200);
    expectSession(await refresh(phone.refreshToken));
  });

  it("validates the body", async () => {
    for (const body of [{}, { refreshToken: "" }]) {
      expectApiError(await post(h.app, "/auth/logout", body), 400, "validation_error");
    }
  });

  it("an access token alone cannot log out the session", async () => {
    const { session } = await activeMember(h);
    expect((await logout(session.accessToken)).statusCode).toBe(204);
    expect((await getMe(h.app, session.accessToken)).statusCode).toBe(200);
  });
});

describe("same account on web, iOS and Android (AC6)", () => {
  const origins = ["https://localhost", "capacitor://localhost", "https://wahyu-forest.github.io"];

  it("sessions from different clients are independent and see the same user", async () => {
    const email = uniqueEmail();
    await signUp(h, email, PASSWORD);
    const sessions = await Promise.all(
      origins.map((origin) => logIn(h, email, PASSWORD, { headers: { origin } })),
    );
    expect(new Set(sessions.map((s) => s.user.id)).size).toBe(1);
    expect(new Set(sessions.map((s) => s.refreshToken)).size).toBe(origins.length);
  });

  it.each(origins)(
    "answers a CORS preflight for POST /auth/login and GET /auth/me from %s",
    async (origin) => {
      const app = (await makeHarness(connection, { corsOrigins: origins })).app;
      try {
        for (const [method, url] of [
          ["POST", "/auth/login"],
          ["GET", "/auth/me"],
        ] as const) {
          const response = await app.inject({
            method: "OPTIONS",
            url,
            headers: {
              origin,
              "access-control-request-method": method,
              "access-control-request-headers": "authorization,content-type",
            },
          });
          expect(response.statusCode, `${method} ${url}`).toBeLessThan(300);
          expect(response.headers["access-control-allow-origin"]).toBe(origin);
          const allowed = String(
            response.headers["access-control-allow-headers"] ?? "",
          ).toLowerCase();
          expect(allowed).toContain("authorization");
          expect(allowed).toContain("content-type");
        }
      } finally {
        await app.close();
      }
    },
  );

  it("does not allow an unknown origin", async () => {
    const app = (await makeHarness(connection, { corsOrigins: origins })).app;
    try {
      const response = await app.inject({
        method: "OPTIONS",
        url: "/auth/login",
        headers: { origin: "https://evil.example", "access-control-request-method": "POST" },
      });
      expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});
