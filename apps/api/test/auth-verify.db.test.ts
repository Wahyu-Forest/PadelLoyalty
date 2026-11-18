/**
 * QA (issue #1), AC2: email verification link (single-use, 24 h expiry,
 * resend invalidates older links, no enumeration on resend).
 */
import { messageResponseSchema, verifyEmailResponseSchema } from "@padelloyalty/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseConnection } from "../src/db/client.js";
import {
  DAY,
  expectApiError,
  getMe,
  type Harness,
  HOUR,
  lastToken,
  logIn,
  makeHarness,
  MINUTE,
  openTestDatabase,
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

async function freshUnverified() {
  const email = uniqueEmail();
  await signUp(h, email);
  return { email, token: lastToken(h.mailer, email, "verify_email") };
}

describe("POST /auth/verify-email", () => {
  it("activates the account", async () => {
    const { email, token } = await freshUnverified();
    const response = await post(h.app, "/auth/verify-email", { token });

    expect(response.statusCode, response.body).toBe(200);
    expect(verifyEmailResponseSchema.parse(response.json()).accountStatus).toBe("active");
    const session = await logIn(h, email);
    expect(session.user).toMatchObject({ status: "active", emailVerified: true });
    const me = await getMe(h.app, session.accessToken);
    expect(me.json().user).toMatchObject({ status: "active", emailVerified: true });
  });

  it("an existing session sees the account become active (status is not frozen in the token)", async () => {
    const { email, token } = await freshUnverified();
    const session = await logIn(h, email);
    expect(session.user.status).toBe("pending_verification");

    await post(h.app, "/auth/verify-email", { token });
    const me = await getMe(h.app, session.accessToken);
    expect(me.json().user.status).toBe("active");
    const refreshed = await post(h.app, "/auth/refresh", { refreshToken: session.refreshToken });
    expect(refreshed.json().user.status).toBe("active");
  });

  it("is single-use: the second use is 400 invalid_token", async () => {
    const { token } = await freshUnverified();
    expect((await post(h.app, "/auth/verify-email", { token })).statusCode).toBe(200);
    expectApiError(await post(h.app, "/auth/verify-email", { token }), 400, "invalid_token");
  });

  it("concurrent uses of one token succeed at most once", async () => {
    const { token } = await freshUnverified();
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => post(h.app, "/auth/verify-email", { token })),
    );
    const codes = responses.map((r) => r.statusCode).sort();
    expect(codes.filter((c) => c === 200)).toHaveLength(1);
    expect(codes.filter((c) => c !== 200 && c !== 400)).toEqual([]);
  });

  it("rejects tampered, truncated and random tokens", async () => {
    const { token } = await freshUnverified();
    const flipped = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
    for (const bad of [flipped, token.slice(0, -4), `${token}x`, "random-token", "' or 1=1 --"]) {
      expectApiError(await post(h.app, "/auth/verify-email", { token: bad }), 400, "invalid_token");
    }
    // The real token still works after the bad attempts.
    expect((await post(h.app, "/auth/verify-email", { token })).statusCode).toBe(200);
  });

  it("rejects missing, empty and oversized tokens with validation_error", async () => {
    for (const body of [{}, { token: "" }, { token: "x".repeat(513) }, { token: 123 }]) {
      expectApiError(await post(h.app, "/auth/verify-email", body), 400, "validation_error");
    }
  });

  it("works just before 24 hours", async () => {
    const { token } = await freshUnverified();
    h.clock.advance(DAY - MINUTE);
    expect((await post(h.app, "/auth/verify-email", { token })).statusCode).toBe(200);
  });

  it("expires after 24 hours", async () => {
    const { token } = await freshUnverified();
    h.clock.advance(DAY + SECOND);
    expectApiError(await post(h.app, "/auth/verify-email", { token }), 400, "invalid_token");
  });

  it("a password-reset token is not accepted as a verification token", async () => {
    const { email } = await freshUnverified();
    await post(h.app, "/auth/password-reset/request", { email });
    const resetToken = lastToken(h.mailer, email, "password_reset");
    expectApiError(
      await post(h.app, "/auth/verify-email", { token: resetToken }),
      400,
      "invalid_token",
    );
  });

  it("puts the base path of APP_URL in the link (GitHub Pages)", async () => {
    const pages = await makeHarness(connection, {
      appUrl: "https://example.github.io/PadelLoyalty",
    });
    try {
      const email = uniqueEmail();
      await signUp(pages, email);
      expect(pages.mailer.lastTo(email, "verify_email")!.link).toMatch(
        /^https:\/\/example\.github\.io\/PadelLoyalty\/verify-email\/#token=[^&\s]+$/,
      );
    } finally {
      await pages.app.close();
    }
  });
});

describe("POST /auth/verify-email/resend", () => {
  it("sends a new link and invalidates the older one", async () => {
    const { email, token: oldToken } = await freshUnverified();
    const response = await post(h.app, "/auth/verify-email/resend", { email });
    expect(response.statusCode).toBe(202);

    const newToken = lastToken(h.mailer, email, "verify_email");
    expect(newToken).not.toBe(oldToken);
    expectApiError(
      await post(h.app, "/auth/verify-email", { token: oldToken }),
      400,
      "invalid_token",
    );
    expect((await post(h.app, "/auth/verify-email", { token: newToken })).statusCode).toBe(200);
  });

  it("a repeated sign-up also invalidates the older link", async () => {
    const { email, token: oldToken } = await freshUnverified();
    await signUp(h, email);
    const newToken = lastToken(h.mailer, email, "verify_email");
    expect(newToken).not.toBe(oldToken);
    expectApiError(
      await post(h.app, "/auth/verify-email", { token: oldToken }),
      400,
      "invalid_token",
    );
    expect((await post(h.app, "/auth/verify-email", { token: newToken })).statusCode).toBe(200);
  });

  it("normalises the email", async () => {
    const { email } = await freshUnverified();
    h.mailer.clear();
    await post(h.app, "/auth/verify-email/resend", { email: `  ${email.toUpperCase()} ` });
    expect(h.mailer.lastTo(email, "verify_email")).toBeTruthy();
  });

  it("answers an unknown email exactly like a known one and sends nothing", async () => {
    const { email } = await freshUnverified();
    const known = await post(h.app, "/auth/verify-email/resend", { email });
    h.mailer.clear();
    const unknownEmail = uniqueEmail("nobody");
    const unknown = await post(h.app, "/auth/verify-email/resend", { email: unknownEmail });

    expect(unknown.statusCode).toBe(202);
    expect(messageResponseSchema.parse(unknown.json())).toEqual(known.json());
    expect(h.mailer.messages).toEqual([]);
  });

  it("answers a verified account the same and sends no verification link", async () => {
    const { email, token } = await freshUnverified();
    const before = await post(h.app, "/auth/verify-email/resend", { email });
    await post(h.app, "/auth/verify-email", { token });
    h.mailer.clear();

    const after = await post(h.app, "/auth/verify-email/resend", { email });
    expect(after.statusCode).toBe(202);
    expect(after.json()).toEqual(before.json());
    expect(h.mailer.messages.filter((m) => m.type === "verify_email")).toEqual([]);
  });

  it("rejects an invalid email with validation_error", async () => {
    expectApiError(
      await post(h.app, "/auth/verify-email/resend", { email: "nope" }),
      400,
      "validation_error",
    );
  });

  it("a link resent after 23 hours is valid for a full 24 hours from the resend", async () => {
    const { email } = await freshUnverified();
    h.clock.advance(23 * HOUR);
    await post(h.app, "/auth/verify-email/resend", { email });
    const token = lastToken(h.mailer, email, "verify_email");
    h.clock.advance(23 * HOUR);
    expect((await post(h.app, "/auth/verify-email", { token })).statusCode).toBe(200);
  });
});
