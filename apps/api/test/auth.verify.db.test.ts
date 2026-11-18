/**
 * #1 AC: "Member verifies their email via a link before the account is fully active".
 */
import { apiErrorResponseSchema, verifyEmailResponseSchema } from "@padelloyalty/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseConnection } from "../src/db/client.js";
import { emailTokens } from "../src/db/schema.js";
import { hashToken } from "../src/auth/crypto.js";
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
const HOUR = 3_600_000;

beforeAll(async () => {
  connection = await connectTestDatabase();
});
afterAll(async () => {
  await connection?.pool.end();
});
beforeEach(async () => {
  await resetAuthTables(connection);
  t = await buildAuthApp(connection);
  await t.post("/auth/signup", { email: EMAIL, password: PASSWORD });
});
afterEach(async () => {
  await t.app.close();
});

describe("before verification", () => {
  it("the account can log in but is not fully active", async () => {
    const login = await t.post("/auth/login", { email: EMAIL, password: PASSWORD });

    expect(login.statusCode).toBe(200);
    expect(login.json().user).toMatchObject({
      status: "pending_verification",
      emailVerified: false,
    });
  });
});

describe("POST /auth/verify-email", () => {
  it("activates the account", async () => {
    const response = await t.post("/auth/verify-email", {
      token: t.tokenFor(EMAIL, "verify_email"),
    });

    expect(response.statusCode).toBe(200);
    expect(verifyEmailResponseSchema.parse(response.json()).accountStatus).toBe("active");
    const login = await t.post("/auth/login", { email: EMAIL, password: PASSWORD });
    expect(login.json().user).toMatchObject({ status: "active", emailVerified: true });
  });

  it("works once only", async () => {
    const token = t.tokenFor(EMAIL, "verify_email");
    await t.post("/auth/verify-email", { token });

    const again = await t.post("/auth/verify-email", { token });

    expect(again.statusCode).toBe(400);
    expect(apiErrorResponseSchema.parse(again.json()).error.code).toBe("invalid_token");
  });

  it("expires after 24 hours", async () => {
    const token = t.tokenFor(EMAIL, "verify_email");
    t.clock.advance(24 * HOUR);

    const response = await t.post("/auth/verify-email", { token });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("invalid_token");
  });

  it("is still valid just before 24 hours", async () => {
    const token = t.tokenFor(EMAIL, "verify_email");
    t.clock.advance(24 * HOUR - 1_000);

    expect((await t.post("/auth/verify-email", { token })).statusCode).toBe(200);
  });

  it("rejects an unknown token and a reset token", async () => {
    expect((await t.post("/auth/verify-email", { token: "ple_made-up" })).json().error.code).toBe(
      "invalid_token",
    );

    await t.post("/auth/password-reset/request", { email: EMAIL });
    const resetToken = t.tokenFor(EMAIL, "password_reset");
    expect((await t.post("/auth/verify-email", { token: resetToken })).statusCode).toBe(400);
  });

  it("stores only a hash of the link token", async () => {
    const token = t.tokenFor(EMAIL, "verify_email");
    const rows = await connection.db.select().from(emailTokens);

    expect(rows.map((r) => r.tokenHash)).toEqual([hashToken(token)]);
    expect(JSON.stringify(rows)).not.toContain(token);
  });
});

describe("POST /auth/verify-email/resend", () => {
  it("sends a new link and invalidates the old one", async () => {
    const oldToken = t.tokenFor(EMAIL, "verify_email");

    const response = await t.post("/auth/verify-email/resend", { email: EMAIL });
    const newToken = t.tokenFor(EMAIL, "verify_email");

    expect(response.statusCode).toBe(202);
    expect(newToken).not.toBe(oldToken);
    expect((await t.post("/auth/verify-email", { token: oldToken })).statusCode).toBe(400);
    expect((await t.post("/auth/verify-email", { token: newToken })).statusCode).toBe(200);
  });

  it("answers the same for unknown and already-verified emails, without sending", async () => {
    const known = await t.post("/auth/verify-email/resend", { email: EMAIL });
    await t.post("/auth/verify-email", { token: t.tokenFor(EMAIL, "verify_email") });
    t.mailer.clear();

    const verified = await t.post("/auth/verify-email/resend", { email: EMAIL });
    const unknown = await t.post("/auth/verify-email/resend", { email: "nobody@example.com" });

    expect([verified.statusCode, unknown.statusCode]).toEqual([202, 202]);
    expect(verified.json()).toEqual(known.json());
    expect(unknown.json()).toEqual(known.json());
    expect(t.mailer.messages).toEqual([]);
  });
});
