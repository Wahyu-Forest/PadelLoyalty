/**
 * #1 AC: "Member can reset a forgotten password via an emailed link
 * (single-use, expiring)" without revealing whether an email is registered.
 */
import { apiErrorResponseSchema, messageResponseSchema } from "@padelloyalty/shared";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseConnection } from "../src/db/client.js";
import { users } from "../src/db/schema.js";
import {
  APP_URL,
  PASSWORD,
  buildAuthApp,
  connectTestDatabase,
  resetAuthTables,
  type TestApp,
} from "./support/auth-app.js";

let connection: DatabaseConnection;
let t: TestApp;
const EMAIL = "ana@example.com";
const NEW_PASSWORD = "a brand new passphrase";
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

const login = (password: string) => t.post("/auth/login", { email: EMAIL, password });

describe("POST /auth/password-reset/request", () => {
  it("emails a reset link to a registered address", async () => {
    await t.signUpVerified(EMAIL);

    const response = await t.post("/auth/password-reset/request", { email: "Ana@Example.com" });

    expect(response.statusCode).toBe(202);
    expect(messageResponseSchema.parse(response.json()).message).toBeTruthy();
    expect(t.mailer.lastTo(EMAIL, "password_reset")?.link).toMatch(
      new RegExp(`^${APP_URL}/reset-password/#token=ple_`),
    );
  });

  it("answers the same for an unknown address and sends nothing", async () => {
    await t.signUpVerified(EMAIL);
    const known = await t.post("/auth/password-reset/request", { email: EMAIL });
    t.mailer.clear();

    const unknown = await t.post("/auth/password-reset/request", { email: "nobody@example.com" });

    expect(unknown.statusCode).toBe(known.statusCode);
    expect(unknown.json()).toEqual(known.json());
    expect(t.mailer.messages).toEqual([]);
  });
});

describe("POST /auth/password-reset/confirm", () => {
  it("sets the new password: the old one stops working", async () => {
    await t.signUpVerified(EMAIL);
    await t.post("/auth/password-reset/request", { email: EMAIL });

    const response = await t.post("/auth/password-reset/confirm", {
      token: t.tokenFor(EMAIL, "password_reset"),
      password: NEW_PASSWORD,
    });

    expect(response.statusCode).toBe(200);
    expect((await login(PASSWORD)).statusCode).toBe(401);
    expect((await login(NEW_PASSWORD)).statusCode).toBe(200);
  });

  it("is single-use", async () => {
    await t.signUpVerified(EMAIL);
    await t.post("/auth/password-reset/request", { email: EMAIL });
    const token = t.tokenFor(EMAIL, "password_reset");
    await t.post("/auth/password-reset/confirm", { token, password: NEW_PASSWORD });

    const again = await t.post("/auth/password-reset/confirm", {
      token,
      password: "yet another passphrase",
    });

    expect(again.statusCode).toBe(400);
    expect(apiErrorResponseSchema.parse(again.json()).error.code).toBe("invalid_token");
    expect((await login(NEW_PASSWORD)).statusCode).toBe(200);
  });

  it("expires after 1 hour", async () => {
    await t.signUpVerified(EMAIL);
    await t.post("/auth/password-reset/request", { email: EMAIL });
    const token = t.tokenFor(EMAIL, "password_reset");
    t.clock.advance(60 * MINUTE);

    const response = await t.post("/auth/password-reset/confirm", {
      token,
      password: NEW_PASSWORD,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("invalid_token");
    expect((await login(PASSWORD)).statusCode).toBe(200);
  });

  it("invalidates an older link when a newer one is requested", async () => {
    await t.signUpVerified(EMAIL);
    await t.post("/auth/password-reset/request", { email: EMAIL });
    const older = t.tokenFor(EMAIL, "password_reset");
    await t.post("/auth/password-reset/request", { email: EMAIL });
    const newer = t.tokenFor(EMAIL, "password_reset");

    expect(
      (await t.post("/auth/password-reset/confirm", { token: older, password: NEW_PASSWORD }))
        .statusCode,
    ).toBe(400);
    expect(
      (await t.post("/auth/password-reset/confirm", { token: newer, password: NEW_PASSWORD }))
        .statusCode,
    ).toBe(200);
  });

  it("logs the account out everywhere", async () => {
    const session = await t.signUpVerified(EMAIL);
    await t.post("/auth/password-reset/request", { email: EMAIL });

    await t.post("/auth/password-reset/confirm", {
      token: t.tokenFor(EMAIL, "password_reset"),
      password: NEW_PASSWORD,
    });

    expect((await t.me(session.accessToken)).statusCode).toBe(401);
    expect((await t.post("/auth/refresh", { refreshToken: session.refreshToken })).statusCode).toBe(
      401,
    );
  });

  it("enforces the password rules and keeps the token usable after a rejected password", async () => {
    await t.signUpVerified(EMAIL);
    await t.post("/auth/password-reset/request", { email: EMAIL });
    const token = t.tokenFor(EMAIL, "password_reset");

    const weak = await t.post("/auth/password-reset/confirm", { token, password: "short" });

    expect(weak.statusCode).toBe(400);
    expect(weak.json().error.fieldErrors.password).toBeDefined();
    expect(
      (await t.post("/auth/password-reset/confirm", { token, password: NEW_PASSWORD })).statusCode,
    ).toBe(200);
  });

  it("verifies the email of an account that never verified (the link proves ownership)", async () => {
    await t.post("/auth/signup", { email: EMAIL, password: PASSWORD });
    await t.post("/auth/password-reset/request", { email: EMAIL });

    await t.post("/auth/password-reset/confirm", {
      token: t.tokenFor(EMAIL, "password_reset"),
      password: NEW_PASSWORD,
    });

    const [row] = await connection.db.select().from(users).where(eq(users.email, EMAIL));
    expect(row?.status).toBe("active");
    expect(row?.emailVerifiedAt).not.toBeNull();
  });

  it("rejects a verification token", async () => {
    await t.post("/auth/signup", { email: EMAIL, password: PASSWORD });

    const response = await t.post("/auth/password-reset/confirm", {
      token: t.tokenFor(EMAIL, "verify_email"),
      password: NEW_PASSWORD,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("invalid_token");
  });
});
