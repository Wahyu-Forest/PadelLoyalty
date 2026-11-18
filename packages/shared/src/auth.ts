import { z } from "zod";

/**
 * Auth API contract (issue #1). Used by the API to validate requests and build
 * responses, and by the web app to validate what it sends and receives.
 * Human-readable version: docs/api/auth.md.
 */

// ---------------------------------------------------------------------------
// Account model
// ---------------------------------------------------------------------------

/** `member` by default. Staff roles exist for later issues (#21, #34, ...). */
export const USER_ROLES = ["member", "receptionist", "club_manager", "admin"] as const;
export const userRoleSchema = z.enum(USER_ROLES);
export type UserRole = z.infer<typeof userRoleSchema>;

export const STAFF_ROLES: readonly UserRole[] = ["receptionist", "club_manager", "admin"];

/**
 * Lifecycle of an account. A status rather than booleans so later issues can
 * add states (e.g. `pending_consent` for under-18 members, #3) without
 * reworking sign-up or login.
 *
 * - `pending_verification`: signed up, email not verified yet. Can log in but
 *   is not fully active.
 * - `active`: email verified; full access.
 */
export const ACCOUNT_STATUSES = ["pending_verification", "active"] as const;
export const accountStatusSchema = z.enum(ACCOUNT_STATUSES);
export type AccountStatus = z.infer<typeof accountStatusSchema>;

// ---------------------------------------------------------------------------
// Field rules
// ---------------------------------------------------------------------------

export const EMAIL_MAX_LENGTH = 254;
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

/** Trimmed and lower-cased, so `Ana@Example.com ` and `ana@example.com` are one account. */
export const emailSchema = z
  .string({ error: "Enter your email address" })
  .trim()
  .toLowerCase()
  .pipe(
    z
      .email({ error: "Enter a valid email address" })
      .max(EMAIL_MAX_LENGTH, { error: "Email address is too long" }),
  );

/**
 * Rules for a new password (sign-up and reset). Length only, following NIST
 * SP 800-63B: no composition rules. Not trimmed: spaces are allowed.
 */
export const newPasswordSchema = z
  .string({ error: "Enter a password" })
  .min(PASSWORD_MIN_LENGTH, {
    error: `Password must be at least ${PASSWORD_MIN_LENGTH} characters`,
  })
  .max(PASSWORD_MAX_LENGTH, {
    error: `Password must be at most ${PASSWORD_MAX_LENGTH} characters`,
  });

/** Password typed at login: any non-empty string (rules are not re-checked). */
const loginPasswordSchema = z
  .string({ error: "Enter your password" })
  .min(1, { error: "Enter your password" })
  .max(1024, { error: "Password is too long" });

/** Opaque token from an email link or issued at login. */
const opaqueTokenSchema = z
  .string({ error: "Token is required" })
  .min(1, { error: "Token is required" })
  .max(512, { error: "Token is too long" });

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/** POST /auth/signup */
export const signUpRequestSchema = z.object({
  email: emailSchema,
  password: newPasswordSchema,
});
export type SignUpRequest = z.infer<typeof signUpRequestSchema>;

/** POST /auth/login */
export const logInRequestSchema = z.object({
  email: emailSchema,
  password: loginPasswordSchema,
});
export type LogInRequest = z.infer<typeof logInRequestSchema>;

/** POST /auth/refresh */
export const refreshRequestSchema = z.object({ refreshToken: opaqueTokenSchema });
export type RefreshRequest = z.infer<typeof refreshRequestSchema>;

/** POST /auth/logout */
export const logOutRequestSchema = z.object({ refreshToken: opaqueTokenSchema });
export type LogOutRequest = z.infer<typeof logOutRequestSchema>;

/** POST /auth/verify-email */
export const verifyEmailRequestSchema = z.object({ token: opaqueTokenSchema });
export type VerifyEmailRequest = z.infer<typeof verifyEmailRequestSchema>;

/** POST /auth/verify-email/resend */
export const resendVerificationRequestSchema = z.object({ email: emailSchema });
export type ResendVerificationRequest = z.infer<typeof resendVerificationRequestSchema>;

/** POST /auth/password-reset/request */
export const passwordResetRequestSchema = z.object({ email: emailSchema });
export type PasswordResetRequest = z.infer<typeof passwordResetRequestSchema>;

/** POST /auth/password-reset/confirm */
export const passwordResetConfirmRequestSchema = z.object({
  token: opaqueTokenSchema,
  password: newPasswordSchema,
});
export type PasswordResetConfirmRequest = z.infer<typeof passwordResetConfirmRequestSchema>;

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export const authUserSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  role: userRoleSchema,
  status: accountStatusSchema,
  emailVerified: z.boolean(),
  createdAt: z.iso.datetime(),
});
export type AuthUser = z.infer<typeof authUserSchema>;

/** 200 from POST /auth/login and POST /auth/refresh. */
export const authSessionResponseSchema = z.object({
  user: authUserSchema,
  /** Send as `Authorization: Bearer <accessToken>`. Short-lived. */
  accessToken: z.string().min(1),
  accessTokenExpiresAt: z.iso.datetime(),
  /** Single use: each refresh returns a new one and invalidates this one. */
  refreshToken: z.string().min(1),
  refreshTokenExpiresAt: z.iso.datetime(),
});
export type AuthSessionResponse = z.infer<typeof authSessionResponseSchema>;

/** 200 from GET /auth/me. */
export const meResponseSchema = z.object({ user: authUserSchema });
export type MeResponse = z.infer<typeof meResponseSchema>;

/**
 * 202 from sign-up, resend verification and password-reset request; 200 from
 * password-reset confirm. The message is the same whether or not the email is
 * registered.
 */
export const messageResponseSchema = z.object({ message: z.string() });
export type MessageResponse = z.infer<typeof messageResponseSchema>;

/** 200 from POST /auth/verify-email. */
export const verifyEmailResponseSchema = z.object({
  message: z.string(),
  /** The account's status after verification (`active` today). */
  accountStatus: accountStatusSchema,
});
export type VerifyEmailResponse = z.infer<typeof verifyEmailResponseSchema>;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export const API_ERROR_CODES = [
  /** 400: body failed validation; see `fieldErrors`. */
  "validation_error",
  /** 401 from login: wrong email or password (never says which). */
  "invalid_credentials",
  /** 401: missing, unknown, expired or revoked access token. */
  "unauthorized",
  /** 401 from refresh: unknown, expired, reused or revoked refresh token. */
  "invalid_refresh_token",
  /** 400 from verify-email / password-reset confirm: unknown, used or expired link token. */
  "invalid_token",
  /** 429: too many attempts; see the `Retry-After` header (seconds). */
  "rate_limited",
  /** 404: unknown route. */
  "not_found",
  /** 500: unexpected error. */
  "internal_error",
] as const;
export const apiErrorCodeSchema = z.enum(API_ERROR_CODES);
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;

/** Body of every error response from the API. */
export const apiErrorResponseSchema = z.object({
  error: z.object({
    code: apiErrorCodeSchema,
    message: z.string(),
    /** Present for `validation_error`: messages per request field. */
    fieldErrors: z.record(z.string(), z.array(z.string())).optional(),
  }),
});
export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;
