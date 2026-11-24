import {
  LOYALTY_PROGRAMME_NAME,
  needsGuardianConsent,
  type AccountStatus,
  type AuthSessionResponse,
  type AuthUser,
  type CalendarDate,
  type SignUpRequest,
} from "@padelloyalty/shared";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { emailTokens, rotatedRefreshTokens, sessions, users, type UserRow } from "../db/schema.js";
import type { Mailer } from "../email/mailer.js";
import type { ConsentService } from "./consent-service.js";
import { ApiError, rateLimited } from "../http/errors.js";
import {
  generateToken,
  hashPassword,
  hashToken,
  verifyDummyPassword,
  verifyPassword,
} from "./crypto.js";
import type { RateLimiter } from "./rate-limit.js";
import { type RateLimitRuleName } from "./rate-limit.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const TOKEN_LIFETIMES = {
  accessMs: 15 * MINUTE,
  /** Sliding: every refresh extends the session by this much from now. */
  refreshMs: 30 * DAY,
  verifyEmailMs: 24 * HOUR,
  passwordResetMs: 1 * HOUR,
} as const;

export const MESSAGES = {
  signUp:
    "Thanks! If this email can be used for a new account, we've sent a link to verify it. Check your inbox.",
  resendVerification:
    "If this email belongs to an account that still needs verifying, we've sent a new link.",
  passwordResetRequested:
    "If this email belongs to an account, we've sent a link to reset the password.",
  passwordReset: "Your password has been changed. Please log in with your new password.",
  emailVerified: "Your email is verified.",
  emailVerifiedPendingConsent:
    "Your email is verified. We've emailed your parent or guardian to ask for their consent.",
} as const;

/**
 * The status an account moves to once its email is verified: `active`, or
 * `pending_consent` for a member who is under 18 on `today` (#3). Accounts
 * without a date of birth (created before #3) count as adults.
 */
export function statusAfterEmailVerified(
  user: Pick<UserRow, "status" | "dateOfBirth">,
  today: CalendarDate,
): AccountStatus {
  if (user.status !== "pending_verification") return user.status;
  if (user.dateOfBirth !== null && needsGuardianConsent(user.dateOfBirth, today)) {
    return "pending_consent";
  }
  return "active";
}

export function toAuthUser(user: UserRow): AuthUser {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    status: user.status,
    emailVerified: user.emailVerifiedAt !== null,
    createdAt: user.createdAt.toISOString(),
  };
}

export interface AuthServiceOptions {
  db: Database;
  mailer: Mailer;
  /** Base URL of the web app (including any base path) for links in emails. */
  appUrl: string;
  limiter: RateLimiter;
  now: () => Date;
  consent: ConsentService;
}

export interface RequestContext {
  ip: string;
  userAgent?: string;
}

export interface AuthenticatedSession {
  user: UserRow;
  sessionId: string;
}

const invalidCredentials = () =>
  new ApiError(401, "invalid_credentials", "Email or password is incorrect.");
const invalidRefreshToken = () =>
  new ApiError(401, "invalid_refresh_token", "Your session has ended. Please log in again.");
const invalidLinkToken = () =>
  new ApiError(400, "invalid_token", "This link is invalid or has expired. Request a new one.");

export class AuthService {
  private readonly db: Database;
  private readonly mailer: Mailer;
  private readonly appUrl: string;
  private readonly limiter: RateLimiter;
  private readonly now: () => Date;
  readonly consent: ConsentService;

  constructor(options: AuthServiceOptions) {
    this.consent = options.consent;
    this.db = options.db;
    this.mailer = options.mailer;
    this.appUrl = options.appUrl.replace(/\/+$/, "");
    this.limiter = options.limiter;
    this.now = options.now;
  }

  // -------------------------------------------------------------------------
  // Sign-up and email verification
  // -------------------------------------------------------------------------

  async signUp(request: SignUpRequest, context: RequestContext): Promise<void> {
    const { email, password, dateOfBirth } = request;
    this.consume("signupPerIp", context.ip);
    // Only under-18s have a guardian; an adult's guardianEmail is ignored.
    const guardianEmail = needsGuardianConsent(dateOfBirth, this.consent.today())
      ? (request.guardianEmail ?? null)
      : null;
    // Hash before looking the email up so both branches take about as long.
    const passwordHash = await hashPassword(password);

    const existing = await this.findUserByEmail(email);
    if (existing) {
      await this.notifyExistingAccount(existing);
      return;
    }

    const now = this.now();
    const inserted = await this.db
      .insert(users)
      .values({ email, passwordHash, dateOfBirth, guardianEmail, createdAt: now, updatedAt: now })
      .onConflictDoNothing()
      .returning();
    const user = inserted[0];
    if (!user) {
      // Lost a race with a simultaneous sign-up for the same email.
      const winner = await this.findUserByEmail(email);
      if (winner) await this.notifyExistingAccount(winner);
      return;
    }
    await this.sendVerificationEmail(user);
  }

  /** Someone signed up with a registered email: tell the owner, not the requester. */
  private async notifyExistingAccount(user: UserRow): Promise<void> {
    // Silently capped so sign-up cannot be used to flood someone's inbox.
    if (this.limiter.consume("emailRequestsPerEmail", user.email).limited) return;
    if (user.emailVerifiedAt === null) {
      await this.sendVerificationEmail(user);
      return;
    }
    await this.mailer.send({
      to: user.email,
      type: "account_exists",
      subject: "You already have a Soul Padel account",
      text: [
        "Someone (hopefully you) tried to create a Soul Padel account with this email address.",
        "You already have an account, so nothing was changed.",
        "",
        `Log in: ${this.appUrl}/login/`,
        `Forgot your password? Reset it: ${this.appUrl}/forgot-password/`,
        "",
        "If this wasn't you, you can ignore this email.",
      ].join("\n"),
      link: `${this.appUrl}/login/`,
    });
  }

  async resendVerification(email: string, context: RequestContext): Promise<void> {
    this.consume("emailRequestsPerIp", context.ip);
    this.consume("emailRequestsPerEmail", email);
    const user = await this.findUserByEmail(email);
    if (user && user.emailVerifiedAt === null) await this.sendVerificationEmail(user);
  }

  async verifyEmail(token: string, context: RequestContext): Promise<AccountStatus> {
    this.consume("tokenAttemptsPerIp", context.ip);
    const { userId, status, needsConsentEmail } = await this.db.transaction(async (tx) => {
      const userId = await this.consumeEmailToken(tx, token, "verify_email");
      if (!userId) throw invalidLinkToken();
      const user = await this.lockUser(tx, userId);
      const now = this.now();
      const status = statusAfterEmailVerified(user, this.consent.today());
      await tx
        .update(users)
        .set({ emailVerifiedAt: user.emailVerifiedAt ?? now, status, updatedAt: now })
        .where(eq(users.id, user.id));
      return { userId, status, needsConsentEmail: becamePendingConsent(user.status, status) };
    });
    if (needsConsentEmail) await this.consent.sendFirstRequest(userId);
    return status;
  }

  private async sendVerificationEmail(user: UserRow): Promise<void> {
    const token = await this.issueEmailToken(
      user.id,
      "verify_email",
      TOKEN_LIFETIMES.verifyEmailMs,
    );
    const link = `${this.appUrl}/verify-email/#token=${encodeURIComponent(token)}`;
    await this.mailer.send({
      to: user.email,
      type: "verify_email",
      subject: "Verify your email for Soul Padel",
      text: [
        `Welcome to Soul Padel and the ${LOYALTY_PROGRAMME_NAME}!`,
        "",
        "Verify your email address to activate your account:",
        link,
        "",
        "This link expires in 24 hours and can be used once.",
        "If you didn't sign up, you can ignore this email.",
      ].join("\n"),
      link,
    });
  }

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  async logIn(
    email: string,
    password: string,
    context: RequestContext,
  ): Promise<AuthSessionResponse> {
    this.consume("loginPerIp", context.ip);
    const perEmail = this.limiter.check("loginFailuresPerEmail", email);
    if (perEmail.limited) throw rateLimited(perEmail.retryAfterSeconds);

    const user = await this.findUserByEmail(email);
    let valid = false;
    if (user?.passwordHash) {
      valid = await verifyPassword(user.passwordHash, password);
    } else {
      await verifyDummyPassword(password);
    }
    if (!user || !valid) {
      this.limiter.hit("loginFailuresPerEmail", email);
      throw invalidCredentials();
    }
    this.limiter.reset("loginFailuresPerEmail", email);
    return this.createSession(user, context);
  }

  /**
   * Starts a session for a user who has proved who they are. Provider-agnostic:
   * Apple or Google sign-in later ends up here too.
   */
  async createSession(user: UserRow, context: RequestContext): Promise<AuthSessionResponse> {
    const now = this.now();
    const tokens = this.newTokenPair(now);
    await this.db.insert(sessions).values({
      userId: user.id,
      accessTokenHash: hashToken(tokens.accessToken),
      accessTokenExpiresAt: tokens.accessTokenExpiresAt,
      refreshTokenHash: hashToken(tokens.refreshToken),
      refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
      userAgent: context.userAgent?.slice(0, 512) ?? null,
      createdAt: now,
    });
    return this.sessionResponse(user, tokens);
  }

  async refresh(refreshToken: string): Promise<AuthSessionResponse> {
    const tokenHash = hashToken(refreshToken);
    const now = this.now();

    const [session] = await this.db
      .select()
      .from(sessions)
      .where(eq(sessions.refreshTokenHash, tokenHash))
      .limit(1);

    if (!session) {
      // A token this session already rotated away from, presented again: it
      // was copied. End the session so neither the thief nor the member can
      // keep using it, however many refreshes ago it was replaced.
      const [rotated] = await this.db
        .select({ sessionId: rotatedRefreshTokens.sessionId })
        .from(rotatedRefreshTokens)
        .where(eq(rotatedRefreshTokens.tokenHash, tokenHash))
        .limit(1);
      if (rotated) {
        await this.db
          .update(sessions)
          .set({ revokedAt: now })
          .where(and(eq(sessions.id, rotated.sessionId), isNull(sessions.revokedAt)));
      }
      throw invalidRefreshToken();
    }
    if (session.revokedAt !== null || session.refreshTokenExpiresAt <= now) {
      throw invalidRefreshToken();
    }

    const tokens = this.newTokenPair(now);
    const rotated = await this.db.transaction(async (tx) => {
      const updated = await tx
        .update(sessions)
        .set({
          accessTokenHash: hashToken(tokens.accessToken),
          accessTokenExpiresAt: tokens.accessTokenExpiresAt,
          refreshTokenHash: hashToken(tokens.refreshToken),
          refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
          lastRefreshedAt: now,
        })
        // Only if nobody rotated it in the meantime (two refreshes racing).
        .where(
          and(
            eq(sessions.id, session.id),
            eq(sessions.refreshTokenHash, tokenHash),
            isNull(sessions.revokedAt),
          ),
        )
        .returning({ id: sessions.id });
      if (updated.length === 0) return false;
      await tx
        .insert(rotatedRefreshTokens)
        .values({ tokenHash, sessionId: session.id, rotatedAt: now });
      return true;
    });
    if (!rotated) throw invalidRefreshToken();

    const [user] = await this.db.select().from(users).where(eq(users.id, session.userId));
    if (!user) throw invalidRefreshToken();
    return this.sessionResponse(user, tokens);
  }

  async logOut(refreshToken: string): Promise<void> {
    await this.db
      .update(sessions)
      .set({ revokedAt: this.now() })
      .where(
        and(eq(sessions.refreshTokenHash, hashToken(refreshToken)), isNull(sessions.revokedAt)),
      );
  }

  /** Resolves a bearer access token to its user, or null if it is not valid now. */
  async authenticate(accessToken: string): Promise<AuthenticatedSession | null> {
    const [row] = await this.db
      .select({ user: users, sessionId: sessions.id })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(
        and(
          eq(sessions.accessTokenHash, hashToken(accessToken)),
          isNull(sessions.revokedAt),
          gt(sessions.accessTokenExpiresAt, this.now()),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  // -------------------------------------------------------------------------
  // Password reset
  // -------------------------------------------------------------------------

  async requestPasswordReset(email: string, context: RequestContext): Promise<void> {
    this.consume("emailRequestsPerIp", context.ip);
    this.consume("emailRequestsPerEmail", email);
    const user = await this.findUserByEmail(email);
    if (!user) return;

    const token = await this.issueEmailToken(
      user.id,
      "password_reset",
      TOKEN_LIFETIMES.passwordResetMs,
    );
    const link = `${this.appUrl}/reset-password/#token=${encodeURIComponent(token)}`;
    await this.mailer.send({
      to: user.email,
      type: "password_reset",
      subject: "Reset your Soul Padel password",
      text: [
        "We received a request to reset the password for your Soul Padel account.",
        "",
        "Choose a new password:",
        link,
        "",
        "This link expires in 1 hour and can be used once.",
        "If you didn't ask for this, you can ignore this email; your password stays the same.",
      ].join("\n"),
      link,
    });
  }

  async confirmPasswordReset(
    token: string,
    password: string,
    context: RequestContext,
  ): Promise<void> {
    this.consume("tokenAttemptsPerIp", context.ip);
    const passwordHash = await hashPassword(password);
    const { userId, needsConsentEmail } = await this.db.transaction(async (tx) => {
      const userId = await this.consumeEmailToken(tx, token, "password_reset");
      if (!userId) throw invalidLinkToken();
      const user = await this.lockUser(tx, userId);
      const now = this.now();
      const status = statusAfterEmailVerified(user, this.consent.today());
      await tx
        .update(users)
        .set({
          passwordHash,
          // Following the emailed link proves the user owns the address.
          emailVerifiedAt: user.emailVerifiedAt ?? now,
          status,
          updatedAt: now,
        })
        .where(eq(users.id, user.id));
      // Log out everywhere: whoever knew the old password loses access.
      await tx
        .update(sessions)
        .set({ revokedAt: now })
        .where(and(eq(sessions.userId, user.id), isNull(sessions.revokedAt)));
      // Any other outstanding reset links stop working too.
      await tx
        .update(emailTokens)
        .set({ consumedAt: now })
        .where(
          and(
            eq(emailTokens.userId, user.id),
            eq(emailTokens.purpose, "password_reset"),
            isNull(emailTokens.consumedAt),
          ),
        );
      return { userId, needsConsentEmail: becamePendingConsent(user.status, status) };
    });
    if (needsConsentEmail) await this.consent.sendFirstRequest(userId);
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private consume(rule: RateLimitRuleName, key: string): void {
    const result = this.limiter.consume(rule, key);
    if (result.limited) throw rateLimited(result.retryAfterSeconds);
  }

  private async findUserByEmail(email: string): Promise<UserRow | undefined> {
    // lower(email) matches the unique index; emails are stored lower-cased anyway.
    const [user] = await this.db
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = ${email.toLowerCase()}`)
      .limit(1);
    return user;
  }

  private async lockUser(tx: Transaction, userId: string): Promise<UserRow> {
    const [user] = await tx.select().from(users).where(eq(users.id, userId)).for("update");
    if (!user) throw invalidLinkToken();
    return user;
  }

  /** Creates a new link token and invalidates older unused ones of the same purpose. */
  private async issueEmailToken(
    userId: string,
    purpose: "verify_email" | "password_reset",
    lifetimeMs: number,
  ): Promise<string> {
    const token = generateToken("email");
    const now = this.now();
    await this.db.transaction(async (tx) => {
      await tx
        .update(emailTokens)
        .set({ consumedAt: now })
        .where(
          and(
            eq(emailTokens.userId, userId),
            eq(emailTokens.purpose, purpose),
            isNull(emailTokens.consumedAt),
          ),
        );
      await tx.insert(emailTokens).values({
        userId,
        purpose,
        tokenHash: hashToken(token),
        expiresAt: new Date(now.getTime() + lifetimeMs),
        createdAt: now,
      });
    });
    return token;
  }

  /**
   * Marks a link token used, atomically: of two simultaneous uses only one
   * succeeds. Returns the user id, or null if the token is unknown, already
   * used, replaced or expired.
   */
  private async consumeEmailToken(
    tx: Transaction,
    token: string,
    purpose: "verify_email" | "password_reset",
  ): Promise<string | null> {
    const now = this.now();
    const [row] = await tx
      .update(emailTokens)
      .set({ consumedAt: now })
      .where(
        and(
          eq(emailTokens.tokenHash, hashToken(token)),
          eq(emailTokens.purpose, purpose),
          isNull(emailTokens.consumedAt),
          gt(emailTokens.expiresAt, now),
        ),
      )
      .returning({ userId: emailTokens.userId });
    return row?.userId ?? null;
  }

  private newTokenPair(now: Date) {
    return {
      accessToken: generateToken("access"),
      accessTokenExpiresAt: new Date(now.getTime() + TOKEN_LIFETIMES.accessMs),
      refreshToken: generateToken("refresh"),
      refreshTokenExpiresAt: new Date(now.getTime() + TOKEN_LIFETIMES.refreshMs),
    };
  }

  private sessionResponse(
    user: UserRow,
    tokens: ReturnType<AuthService["newTokenPair"]>,
  ): AuthSessionResponse {
    return {
      user: toAuthUser(user),
      accessToken: tokens.accessToken,
      accessTokenExpiresAt: tokens.accessTokenExpiresAt.toISOString(),
      refreshToken: tokens.refreshToken,
      refreshTokenExpiresAt: tokens.refreshTokenExpiresAt.toISOString(),
    };
  }
}

/** True when verifying the email just moved an under-18 account to `pending_consent`. */
function becamePendingConsent(before: AccountStatus, after: AccountStatus): boolean {
  return before === "pending_verification" && after === "pending_consent";
}

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
