/**
 * QA (issue #1), AC4: password reset by emailed link (single-use, 1 h expiry,
 * newer link invalidates older, revokes every session, verifies the email).
 */
import { messageResponseSchema } from "@padelloyalty/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseConnection } from "../src/db/client.js";
import {
  activeMember,
  APP_URL,
  expectApiError,
  expectSession,
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

const NEW_PASSWORD = "brand new password 42";

async function requestReset(email: string) {
  const response = await post(h.app, "/auth/password-reset/request", { email });
  expect(response.statusCode, response.body).toBe(202);
  return response;
}
const confirm = (token: string, password = NEW_PASSWORD) =>
  post(h.app, "/auth/password-reset/confirm", { token, password });

describe("POST /auth/password-reset/request", () => {
  it("emails a reset link to a registered address", async () => {
    const { email } = await activeMember(h);
    const response = await requestReset(email);

    expect(messageResponseSchema.safeParse(response.json()).success).toBe(true);
    expect(h.mailer.lastTo(email, "password_reset")!.link).toMatch(
      new RegExp(`^${APP_URL}/reset-password/#token=.+`),
    );
  });

  it("answers an unknown address exactly the same and sends nothing", async () => {
    const { email } = await activeMember(h);
    const known = await requestReset(email);
    h.mailer.clear();
    const unknown = await requestReset(uniqueEmail("nobody"));

    expect(unknown.json()).toEqual(known.json());
    expect(h.mailer.messages).toEqual([]);
  });

  it("normalises the email", async () => {
    const { email } = await activeMember(h);
    await requestReset(`  ${email.toUpperCase()} `);
    expect(h.mailer.lastTo(email, "password_reset")).toBeTruthy();
  });

  it("does not change the password or end sessions just by being requested", async () => {
    const { email, password, session } = await activeMember(h);
    await requestReset(email);
    await logIn(h, email, password);
    expect((await getMe(h.app, session.accessToken)).statusCode).toBe(200);
  });

  it("rejects an invalid email with validation_error", async () => {
    expectApiError(
      await post(h.app, "/auth/password-reset/request", { email: "nope" }),
      400,
      "validation_error",
    );
  });
});

describe("POST /auth/password-reset/confirm", () => {
  it("sets the new password; the old one stops working", async () => {
    const { email, password } = await activeMember(h);
    await requestReset(email);
    const response = await confirm(lastToken(h.mailer, email, "password_reset"));

    expect(response.statusCode, response.body).toBe(200);
    expect(messageResponseSchema.safeParse(response.json()).success).toBe(true);
    await logIn(h, email, NEW_PASSWORD);
    expectApiError(
      await post(h.app, "/auth/login", { email, password }),
      401,
      "invalid_credentials",
    );
  });

  it("is single-use", async () => {
    const { email } = await activeMember(h);
    await requestReset(email);
    const token = lastToken(h.mailer, email, "password_reset");
    expect((await confirm(token)).statusCode).toBe(200);
    expectApiError(await confirm(token, "yet another password"), 400, "invalid_token");
    await logIn(h, email, NEW_PASSWORD);
  });

  it("concurrent confirms with one token succeed at most once", async () => {
    const { email } = await activeMember(h);
    await requestReset(email);
    const token = lastToken(h.mailer, email, "password_reset");
    const passwords = Array.from({ length: 5 }, (_, i) => `racing password ${i}`);
    const responses = await Promise.all(passwords.map((p) => confirm(token, p)));

    expect(responses.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(responses.every((r) => r.statusCode === 200 || r.statusCode === 400)).toBe(true);
    const winner = passwords[responses.findIndex((r) => r.statusCode === 200)]!;
    await logIn(h, email, winner);
  });

  it("enforces the password rules and does not use up the token on a weak password", async () => {
    const { email } = await activeMember(h);
    await requestReset(email);
    const token = lastToken(h.mailer, email, "password_reset");

    for (const weak of ["short", "x".repeat(129)]) {
      const error = expectApiError(await confirm(token, weak), 400, "validation_error");
      expect(error.error.fieldErrors?.password?.length).toBeGreaterThan(0);
    }
    expect((await confirm(token)).statusCode).toBe(200);
  });

  it("works just before 1 hour and expires after 1 hour", async () => {
    const a = await activeMember(h);
    await requestReset(a.email);
    const tokenA = lastToken(h.mailer, a.email, "password_reset");
    h.clock.advance(HOUR - MINUTE);
    expect((await confirm(tokenA)).statusCode).toBe(200);

    const b = await activeMember(h);
    await requestReset(b.email);
    const tokenB = lastToken(h.mailer, b.email, "password_reset");
    h.clock.advance(HOUR + SECOND);
    expectApiError(await confirm(tokenB), 400, "invalid_token");
    await logIn(h, b.email, b.password);
  });

  it("a newer reset link invalidates the older one", async () => {
    const { email } = await activeMember(h);
    await requestReset(email);
    const first = lastToken(h.mailer, email, "password_reset");
    await requestReset(email);
    const second = lastToken(h.mailer, email, "password_reset");

    expect(second).not.toBe(first);
    expectApiError(await confirm(first), 400, "invalid_token");
    expect((await confirm(second)).statusCode).toBe(200);
  });

  it("rejects tampered, random and verification tokens", async () => {
    const { email } = await activeMember(h);
    await requestReset(email);
    const token = lastToken(h.mailer, email, "password_reset");
    const verifyToken = lastToken(h.mailer, email, "verify_email"); // already used, but still a different type
    const flipped = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");

    for (const bad of [flipped, token.slice(0, -3), "random", verifyToken]) {
      expectApiError(await confirm(bad), 400, "invalid_token");
    }
    expect((await confirm(token)).statusCode).toBe(200);
  });

  it("an unused verification token is not accepted as a reset token", async () => {
    const email = uniqueEmail();
    await signUp(h, email);
    const verifyToken = lastToken(h.mailer, email, "verify_email");
    expectApiError(await confirm(verifyToken), 400, "invalid_token");
  });

  it("revokes every session of the account (log out everywhere)", async () => {
    const { email, password, session } = await activeMember(h);
    const second = await logIn(h, email, password);
    await requestReset(email);
    expect((await confirm(lastToken(h.mailer, email, "password_reset"))).statusCode).toBe(200);

    for (const s of [session, second]) {
      expectApiError(await getMe(h.app, s.accessToken), 401, "unauthorized");
      expectApiError(
        await post(h.app, "/auth/refresh", { refreshToken: s.refreshToken }),
        401,
        "invalid_refresh_token",
      );
    }
    // A fresh login works.
    const fresh = await logIn(h, email, NEW_PASSWORD);
    expect((await getMe(h.app, fresh.accessToken)).statusCode).toBe(200);
  });

  it("does not revoke other accounts' sessions", async () => {
    const a = await activeMember(h);
    const b = await activeMember(h);
    await requestReset(a.email);
    await confirm(lastToken(h.mailer, a.email, "password_reset"));
    expect((await getMe(h.app, b.session.accessToken)).statusCode).toBe(200);
  });

  it("verifies the email of an unverified account", async () => {
    const email = uniqueEmail();
    await signUp(h, email);
    await requestReset(email);
    expect((await confirm(lastToken(h.mailer, email, "password_reset"))).statusCode).toBe(200);

    const session = await logIn(h, email, NEW_PASSWORD);
    expect(session.user).toMatchObject({ status: "active", emailVerified: true });
  });

  it("validates the body", async () => {
    for (const body of [
      {},
      { token: "x" },
      { password: NEW_PASSWORD },
      { token: "", password: NEW_PASSWORD },
    ]) {
      expectApiError(
        await post(h.app, "/auth/password-reset/confirm", body),
        400,
        "validation_error",
      );
    }
  });

  it("a refresh token minted before the reset cannot be rotated afterwards", async () => {
    const { email, session } = await activeMember(h);
    const rotated = expectSession(
      await post(h.app, "/auth/refresh", { refreshToken: session.refreshToken }),
    );
    await requestReset(email);
    await confirm(lastToken(h.mailer, email, "password_reset"));
    expectApiError(
      await post(h.app, "/auth/refresh", { refreshToken: rotated.refreshToken }),
      401,
      "invalid_refresh_token",
    );
  });
});
