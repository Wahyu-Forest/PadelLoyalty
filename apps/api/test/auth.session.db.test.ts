/**
 * #1 AC: "Member can log in and log out; session persists between app
 * launches", "doesn't reveal whether an email is registered", and
 * "Same account works in the iOS, Android and web apps" (token sessions that
 * work cross-origin, one session per device).
 */
import { apiErrorResponseSchema, authSessionResponseSchema } from "@padelloyalty/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { hashToken } from "../src/auth/crypto.js";
import type { DatabaseConnection } from "../src/db/client.js";
import { sessions } from "../src/db/schema.js";
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
const DAY = 24 * 60 * MINUTE;

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

describe("POST /auth/login", () => {
  it("returns a session with short-lived access and long-lived refresh tokens", async () => {
    await t.signUpVerified(EMAIL);
    const response = await t.post("/auth/login", { email: " ANA@example.com", password: PASSWORD });

    expect(response.statusCode).toBe(200);
    const body = authSessionResponseSchema.parse(response.json());
    expect(body.user).toMatchObject({ email: EMAIL, role: "member", status: "active" });
    expect(body.accessToken).toMatch(/^pla_/);
    expect(body.refreshToken).toMatch(/^plr_/);
    const now = t.clock.now().getTime();
    expect(Date.parse(body.accessTokenExpiresAt) - now).toBe(15 * MINUTE);
    expect(Date.parse(body.refreshTokenExpiresAt) - now).toBe(30 * DAY);
  });

  it("gives the same answer for a wrong password and an unknown email", async () => {
    await t.signUpVerified(EMAIL);

    const wrongPassword = await t.post("/auth/login", { email: EMAIL, password: "wrong password" });
    const unknownEmail = await t.post("/auth/login", {
      email: "nobody@example.com",
      password: PASSWORD,
    });

    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownEmail.statusCode).toBe(401);
    expect(wrongPassword.json()).toEqual(unknownEmail.json());
    expect(apiErrorResponseSchema.parse(wrongPassword.json()).error.code).toBe(
      "invalid_credentials",
    );
  });

  it("stores only hashes of the tokens", async () => {
    const { accessToken, refreshToken } = await t.signUpVerified(EMAIL);

    const rows = await connection.db.select().from(sessions);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.accessTokenHash).toBe(hashToken(accessToken));
    expect(rows[0]?.refreshTokenHash).toBe(hashToken(refreshToken));
    expect(JSON.stringify(rows)).not.toContain(accessToken);
    expect(JSON.stringify(rows)).not.toContain(refreshToken);
  });

  it("allows one session per device: web and phone logged in at once", async () => {
    const web = await t.signUpVerified(EMAIL);
    const phone = (await t.post("/auth/login", { email: EMAIL, password: PASSWORD })).json();

    expect((await t.me(web.accessToken)).statusCode).toBe(200);
    expect((await t.me(phone.accessToken)).statusCode).toBe(200);
    expect((await t.me(phone.accessToken)).json().user.id).toBe(web.user.id);
  });
});

describe("GET /auth/me", () => {
  it("returns the user for a valid access token", async () => {
    const { accessToken } = await t.signUpVerified(EMAIL);

    const response = await t.me(accessToken);

    expect(response.statusCode).toBe(200);
    expect(response.json().user).toMatchObject({ email: EMAIL, emailVerified: true });
  });

  it.each([
    ["no header", undefined],
    ["a malformed header", "Token abc"],
    ["an unknown token", "Bearer pla_unknown"],
  ])("rejects %s", async (_name, authorization) => {
    const response = await t.app.inject({
      method: "GET",
      url: "/auth/me",
      headers: authorization ? { authorization } : {},
    });

    expect(response.statusCode).toBe(401);
    expect(apiErrorResponseSchema.parse(response.json()).error.code).toBe("unauthorized");
  });

  it("rejects an access token after 15 minutes", async () => {
    const { accessToken } = await t.signUpVerified(EMAIL);
    t.clock.advance(15 * MINUTE);

    expect((await t.me(accessToken)).statusCode).toBe(401);
  });

  it("rejects a refresh token used as an access token", async () => {
    const { refreshToken } = await t.signUpVerified(EMAIL);

    expect((await t.me(refreshToken)).statusCode).toBe(401);
  });
});

describe("POST /auth/refresh (session persists between app launches)", () => {
  it("issues new tokens from the stored refresh token after the access token expired", async () => {
    const first = await t.signUpVerified(EMAIL);
    // The app is closed for a week, then reopened with only the stored refresh token.
    t.clock.advance(7 * DAY);
    expect((await t.me(first.accessToken)).statusCode).toBe(401);

    const response = await t.post("/auth/refresh", { refreshToken: first.refreshToken });

    expect(response.statusCode).toBe(200);
    const body = authSessionResponseSchema.parse(response.json());
    expect(body.refreshToken).not.toBe(first.refreshToken);
    expect(body.accessToken).not.toBe(first.accessToken);
    expect((await t.me(body.accessToken)).json().user.email).toBe(EMAIL);
    expect(Date.parse(body.refreshTokenExpiresAt) - t.clock.now().getTime()).toBe(30 * DAY);
  });

  it("rotates: the old refresh token cannot be used again", async () => {
    const first = await t.signUpVerified(EMAIL);
    await t.post("/auth/refresh", { refreshToken: first.refreshToken });

    const reuse = await t.post("/auth/refresh", { refreshToken: first.refreshToken });

    expect(reuse.statusCode).toBe(401);
    expect(reuse.json().error.code).toBe("invalid_refresh_token");
  });

  it("revokes the whole session when a rotated refresh token is reused (theft)", async () => {
    const first = await t.signUpVerified(EMAIL);
    const second = (await t.post("/auth/refresh", { refreshToken: first.refreshToken })).json();

    await t.post("/auth/refresh", { refreshToken: first.refreshToken });

    expect((await t.post("/auth/refresh", { refreshToken: second.refreshToken })).statusCode).toBe(
      401,
    );
    expect((await t.me(second.accessToken)).statusCode).toBe(401);
  });

  it("lets only one of two simultaneous refreshes with the same token succeed", async () => {
    const first = await t.signUpVerified(EMAIL);

    const results = await Promise.all([
      t.post("/auth/refresh", { refreshToken: first.refreshToken }),
      t.post("/auth/refresh", { refreshToken: first.refreshToken }),
    ]);

    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 401]);
  });

  it("expires after 30 days without use", async () => {
    const first = await t.signUpVerified(EMAIL);
    t.clock.advance(30 * DAY);

    expect((await t.post("/auth/refresh", { refreshToken: first.refreshToken })).statusCode).toBe(
      401,
    );
  });

  it("rejects an unknown refresh token and a missing body", async () => {
    expect((await t.post("/auth/refresh", { refreshToken: "plr_unknown" })).statusCode).toBe(401);
    const missing = await t.post("/auth/refresh", {});
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.code).toBe("validation_error");
  });
});

describe("POST /auth/logout", () => {
  it("ends the session: access and refresh tokens stop working at once", async () => {
    const { accessToken, refreshToken } = await t.signUpVerified(EMAIL);

    const response = await t.post("/auth/logout", { refreshToken });

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe("");
    expect((await t.me(accessToken)).statusCode).toBe(401);
    expect((await t.post("/auth/refresh", { refreshToken })).statusCode).toBe(401);
  });

  it("logs out only this device", async () => {
    const web = await t.signUpVerified(EMAIL);
    const phone = (await t.post("/auth/login", { email: EMAIL, password: PASSWORD })).json();

    await t.post("/auth/logout", { refreshToken: web.refreshToken });

    expect((await t.me(phone.accessToken)).statusCode).toBe(200);
  });

  it("is idempotent and does not reveal unknown tokens", async () => {
    const { refreshToken } = await t.signUpVerified(EMAIL);
    await t.post("/auth/logout", { refreshToken });

    expect((await t.post("/auth/logout", { refreshToken })).statusCode).toBe(204);
    expect((await t.post("/auth/logout", { refreshToken: "plr_unknown" })).statusCode).toBe(204);
  });
});

describe("cross-origin use from the web and Capacitor apps", () => {
  it.each([["GitHub Pages", "https://wahyu-forest.github.io"]])(
    "answers a CORS preflight for an authenticated call from %s",
    async (_name, origin) => {
      const response = await t.app.inject({
        method: "OPTIONS",
        url: "/auth/me",
        headers: {
          origin,
          "access-control-request-method": "GET",
          "access-control-request-headers": "authorization",
        },
      });

      expect(response.statusCode).toBe(204);
      expect(response.headers["access-control-allow-origin"]).toBe(origin);
      expect(String(response.headers["access-control-allow-headers"])).toMatch(/authorization/i);
    },
  );

  it("exposes Retry-After to browser clients", async () => {
    const response = await t.app.inject({
      method: "POST",
      url: "/auth/login",
      headers: { origin: "https://wahyu-forest.github.io" },
      payload: { email: EMAIL, password: PASSWORD },
    });

    expect(String(response.headers["access-control-expose-headers"])).toMatch(/retry-after/i);
  });
});

describe("unknown routes", () => {
  it("answer 404 with the error body", async () => {
    const response = await t.app.inject({ method: "GET", url: "/auth/nope" });

    expect(response.statusCode).toBe(404);
    expect(apiErrorResponseSchema.parse(response.json()).error.code).toBe("not_found");
  });
});
