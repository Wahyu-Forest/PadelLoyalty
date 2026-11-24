import { describe, expect, it } from "vitest";
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  apiErrorResponseSchema,
  authSessionResponseSchema,
  emailSchema,
  logInRequestSchema,
  newPasswordSchema,
  signUpRequestSchema,
  userRoleSchema,
} from "./index.js";

describe("emailSchema", () => {
  it("trims and lower-cases", () => {
    expect(emailSchema.parse("  Ana@Example.COM ")).toBe("ana@example.com");
  });

  it("rejects invalid and over-long addresses", () => {
    expect(emailSchema.safeParse("not-an-email").success).toBe(false);
    expect(emailSchema.safeParse("").success).toBe(false);
    expect(emailSchema.safeParse(`${"a".repeat(250)}@x.io`).success).toBe(false);
  });
});

describe("newPasswordSchema", () => {
  it(`requires ${PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_LENGTH} characters`, () => {
    expect(newPasswordSchema.safeParse("a".repeat(PASSWORD_MIN_LENGTH - 1)).success).toBe(false);
    expect(newPasswordSchema.safeParse("a".repeat(PASSWORD_MIN_LENGTH)).success).toBe(true);
    expect(newPasswordSchema.safeParse("a".repeat(PASSWORD_MAX_LENGTH)).success).toBe(true);
    expect(newPasswordSchema.safeParse("a".repeat(PASSWORD_MAX_LENGTH + 1)).success).toBe(false);
  });

  it("keeps spaces (passphrases)", () => {
    expect(newPasswordSchema.parse("  correct horse  ")).toBe("  correct horse  ");
  });
});

describe("request schemas", () => {
  it("sign-up enforces the password rules; login does not", () => {
    expect(signUpRequestSchema.safeParse({ email: "a@b.co", password: "short" }).success).toBe(
      false,
    );
    expect(logInRequestSchema.safeParse({ email: "a@b.co", password: "short" }).success).toBe(true);
    expect(logInRequestSchema.safeParse({ email: "a@b.co", password: "" }).success).toBe(false);
  });
});

describe("roles", () => {
  it("has member plus the staff roles", () => {
    expect(userRoleSchema.options).toEqual(["member", "receptionist", "club_manager", "admin"]);
  });
});

describe("response schemas", () => {
  it("accepts a session response", () => {
    const now = "2026-11-18T10:00:00.000Z";
    const body = {
      user: {
        id: "0b6c5f0e-3c1a-4c1e-9a55-2d7f2b9d8e11",
        email: "ana@example.com",
        role: "member",
        status: "active",
        emailVerified: true,
        createdAt: now,
      },
      accessToken: "pla_x",
      accessTokenExpiresAt: now,
      refreshToken: "plr_y",
      refreshTokenExpiresAt: now,
    };
    expect(authSessionResponseSchema.parse(body)).toEqual(body);
  });

  it("accepts an error body and rejects unknown codes", () => {
    expect(
      apiErrorResponseSchema.safeParse({
        error: { code: "validation_error", message: "x", fieldErrors: { email: ["bad"] } },
      }).success,
    ).toBe(true);
    expect(
      apiErrorResponseSchema.safeParse({ error: { code: "nope", message: "x" } }).success,
    ).toBe(false);
  });
});
