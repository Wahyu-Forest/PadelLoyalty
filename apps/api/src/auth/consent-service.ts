import {
  GUARDIAN_CONSENT_LINK_DAYS,
  LOYALTY_PROGRAMME_NAME,
  SAFEGUARDING_POLICY_PLACEHOLDER,
  calendarDateUtc,
  needsGuardianConsent,
  type CalendarDate,
  type ConsentDecision,
  type ConsentReviewResponse,
  type ConsentStatusResponse,
} from "@padelloyalty/shared";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import {
  guardianConsentRequests,
  users,
  type GuardianConsentRequestRow,
  type UserRow,
} from "../db/schema.js";
import type { Mailer } from "../email/mailer.js";
import { ApiError, rateLimited } from "../http/errors.js";
import { generateToken, hashToken } from "./crypto.js";
import type { RateLimiter, RateLimitRuleName } from "./rate-limit.js";

const DAY = 24 * 60 * 60_000;
export const GUARDIAN_CONSENT_LIFETIME_MS = GUARDIAN_CONSENT_LINK_DAYS * DAY;

export const CONSENT_MESSAGES = {
  confirmed: "Thank you. You've given consent, and the account is now active.",
  declined: "You've declined. The account stays inactive. Thank you for letting us know.",
} as const;

export interface ConsentServiceOptions {
  db: Database;
  mailer: Mailer;
  /** Base URL of the web app (including any base path) for links in emails. */
  appUrl: string;
  limiter: RateLimiter;
  now: () => Date;
}

export interface DecisionContext {
  ip: string;
  userAgent?: string;
}

const invalidConsentLink = () =>
  new ApiError(
    400,
    "invalid_token",
    "This consent link is invalid, has already been used or has expired. The member can send a new one.",
  );

const consentNotRequired = () =>
  new ApiError(409, "consent_not_required", "This account doesn't need guardian consent.");

const guardianDeclined = () =>
  new ApiError(
    409,
    "guardian_declined",
    "This parent or guardian has already declined. Ask a different parent or guardian.",
  );

const sameAsMember = () =>
  new ApiError(400, "validation_error", "Some fields are missing or invalid.", {
    fieldErrors: {
      guardianEmail: ["Your parent or guardian's email must be different from yours"],
    },
  });

/**
 * Guardian consent for under-18 members (#3): sending consent links, the
 * member's consent status, and the guardian's decision. Every consent email is
 * one row in `guardian_consent_requests` (the audit record).
 */
export class ConsentService {
  private readonly db: Database;
  private readonly mailer: Mailer;
  private readonly appUrl: string;
  private readonly limiter: RateLimiter;
  private readonly now: () => Date;

  constructor(options: ConsentServiceOptions) {
    this.db = options.db;
    this.mailer = options.mailer;
    this.appUrl = options.appUrl.replace(/\/+$/, "");
    this.limiter = options.limiter;
    this.now = options.now;
  }

  /** Today's date in UTC, `YYYY-MM-DD`: the date ages are computed on. */
  today(): CalendarDate {
    return calendarDateUtc(this.now());
  }

  /** True when this member is under 18 today. Accounts without a date of birth (pre-#3) are not. */
  isMinor(user: Pick<UserRow, "dateOfBirth">): boolean {
    return user.dateOfBirth !== null && needsGuardianConsent(user.dateOfBirth, this.today());
  }

  // -------------------------------------------------------------------------
  // The member's side
  // -------------------------------------------------------------------------

  async status(user: UserRow): Promise<ConsentStatusResponse> {
    const empty = { requestedAt: null, expiresAt: null, decidedAt: null };
    if (user.status === "active") {
      const [granted] = await this.db
        .select()
        .from(guardianConsentRequests)
        .where(
          and(
            eq(guardianConsentRequests.userId, user.id),
            eq(guardianConsentRequests.status, "confirmed"),
          ),
        )
        .orderBy(desc(guardianConsentRequests.decidedAt))
        .limit(1);
      if (!granted) return { state: "not_required", guardianEmail: null, ...empty };
      return { state: "granted", ...this.describe(granted) };
    }

    if (user.status === "pending_verification") {
      if (!this.isMinor(user) || user.guardianEmail === null) {
        return { state: "not_required", guardianEmail: null, ...empty };
      }
      return { state: "awaiting_member_verification", guardianEmail: user.guardianEmail, ...empty };
    }

    // pending_consent
    const latest = await this.latestRequest(user.id);
    if (!latest) return { state: "not_sent", guardianEmail: user.guardianEmail, ...empty };
    const described = { ...this.describe(latest), guardianEmail: user.guardianEmail };
    switch (latest.status) {
      case "confirmed":
        return { state: "granted", ...described };
      case "declined":
        return { state: "declined", ...described };
      case "pending":
        return latest.expiresAt > this.now()
          ? { state: "pending", ...described }
          : { state: "expired", ...described };
      case "superseded":
        // Only when a send was interrupted after replacing the old request.
        return { state: "not_sent", guardianEmail: user.guardianEmail, ...empty };
    }
  }

  /**
   * Resend the consent email (no `guardianEmail`) or switch to another
   * guardian. Before the member has verified their email, only stores the
   * new guardian; nothing is sent until verification.
   */
  async request(
    user: UserRow,
    guardianEmail: string | undefined,
    context: DecisionContext,
  ): Promise<ConsentStatusResponse> {
    this.consume("emailRequestsPerIp", context.ip);
    this.consume("consentRequestsPerAccount", user.id);

    const awaitingVerification = user.status === "pending_verification" && this.isMinor(user);
    if (user.status !== "pending_consent" && !awaitingVerification) throw consentNotRequired();

    const target = guardianEmail ?? user.guardianEmail;
    if (target === null) {
      throw new ApiError(400, "validation_error", "Some fields are missing or invalid.", {
        fieldErrors: { guardianEmail: ["Enter your parent or guardian's email"] },
      });
    }
    if (target === user.email) throw sameAsMember();

    if (awaitingVerification) {
      if (target !== user.guardianEmail) {
        await this.db
          .update(users)
          .set({ guardianEmail: target, updatedAt: this.now() })
          .where(eq(users.id, user.id));
      }
      return this.status({ ...user, guardianEmail: target });
    }

    const [declined] = await this.db
      .select({ id: guardianConsentRequests.id })
      .from(guardianConsentRequests)
      .where(
        and(
          eq(guardianConsentRequests.userId, user.id),
          eq(guardianConsentRequests.guardianEmail, target),
          eq(guardianConsentRequests.status, "declined"),
        ),
      )
      .limit(1);
    if (declined) throw guardianDeclined();

    this.consume("consentEmailsPerGuardian", target);
    const sent = await this.send(user, target);
    if (!sent) throw consentNotRequired();
    return this.status(sent);
  }

  /**
   * First consent email, right after an under-18 member verified their email
   * (the account is now `pending_consent`). Silently skipped when the
   * guardian's address is over its rate limit; the member can send it later.
   */
  async sendFirstRequest(userId: string): Promise<void> {
    const [user] = await this.db.select().from(users).where(eq(users.id, userId));
    if (!user || user.status !== "pending_consent" || user.guardianEmail === null) return;
    if (this.limiter.consume("consentEmailsPerGuardian", user.guardianEmail).limited) return;
    await this.send(user, user.guardianEmail);
  }

  // -------------------------------------------------------------------------
  // The guardian's side
  // -------------------------------------------------------------------------

  async review(token: string, context: DecisionContext): Promise<ConsentReviewResponse> {
    this.consume("tokenAttemptsPerIp", context.ip);
    const [row] = await this.db
      .select({ request: guardianConsentRequests, memberEmail: users.email })
      .from(guardianConsentRequests)
      .innerJoin(users, eq(users.id, guardianConsentRequests.userId))
      .where(this.liveToken(token))
      .limit(1);
    if (!row) throw invalidConsentLink();
    return {
      memberEmail: row.memberEmail,
      memberDateOfBirth: row.request.memberDateOfBirth,
      guardianEmail: row.request.guardianEmail,
      expiresAt: row.request.expiresAt.toISOString(),
    };
  }

  async decide(
    token: string,
    decision: ConsentDecision,
    context: DecisionContext,
  ): Promise<{ message: string; decision: ConsentDecision }> {
    this.consume("tokenAttemptsPerIp", context.ip);
    await this.db.transaction(async (tx) => {
      const now = this.now();
      // Atomic: of two simultaneous decisions on one link, only one matches.
      const [decided] = await tx
        .update(guardianConsentRequests)
        .set({
          status: decision === "confirm" ? "confirmed" : "declined",
          decidedAt: now,
          decidedIp: context.ip,
          decidedUserAgent: context.userAgent?.slice(0, 512) ?? null,
          guardianAttested: decision === "confirm",
        })
        .where(this.liveToken(token))
        .returning({ userId: guardianConsentRequests.userId });
      if (!decided) throw invalidConsentLink();
      if (decision === "confirm") {
        await tx
          .update(users)
          .set({ status: "active", updatedAt: now })
          .where(and(eq(users.id, decided.userId), eq(users.status, "pending_consent")));
      }
    });
    return {
      decision,
      message: decision === "confirm" ? CONSENT_MESSAGES.confirmed : CONSENT_MESSAGES.declined,
    };
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * Replaces any live request with a new one to `guardianEmail` and emails
   * the link. Returns the updated user, or null if the account is no longer
   * waiting for consent.
   */
  private async send(user: UserRow, guardianEmail: string): Promise<UserRow | null> {
    const token = generateToken("consent");
    const now = this.now();
    const expiresAt = new Date(now.getTime() + GUARDIAN_CONSENT_LIFETIME_MS);

    const updated = await this.db.transaction(async (tx) => {
      const [locked] = await tx.select().from(users).where(eq(users.id, user.id)).for("update");
      if (!locked || locked.status !== "pending_consent" || locked.dateOfBirth === null) {
        return null;
      }
      await tx
        .update(guardianConsentRequests)
        .set({ status: "superseded", supersededAt: now })
        .where(
          and(
            eq(guardianConsentRequests.userId, user.id),
            eq(guardianConsentRequests.status, "pending"),
          ),
        );
      await tx.insert(guardianConsentRequests).values({
        userId: user.id,
        guardianEmail,
        memberDateOfBirth: locked.dateOfBirth,
        tokenHash: hashToken(token),
        requestedAt: now,
        expiresAt,
      });
      const [row] = await tx
        .update(users)
        .set({ guardianEmail, updatedAt: now })
        .where(eq(users.id, user.id))
        .returning();
      return row ?? null;
    });
    if (!updated) return null;

    const link = `${this.appUrl}/guardian-consent/#token=${encodeURIComponent(token)}`;
    await this.mailer.send({
      to: guardianEmail,
      type: "guardian_consent",
      subject: `Please review: ${updated.email} wants to join Soul Padel`,
      text: [
        "Hello,",
        "",
        `${updated.email} has signed up for a Soul Padel account and the ${LOYALTY_PROGRAMME_NAME}.`,
        "They told us they are under 18 and gave your email address as their parent or guardian.",
        "",
        "They can't use the app until a parent or guardian gives consent.",
        "Review the request, then confirm or decline:",
        link,
        "",
        `This link expires in ${GUARDIAN_CONSENT_LINK_DAYS} days and can be used once.`,
        "If you don't know this person or didn't expect this email, you can decline using the link,",
        "or ignore this email: the account stays inactive.",
        "",
        `Safeguarding: ${SAFEGUARDING_POLICY_PLACEHOLDER}`,
      ].join("\n"),
      link,
    });
    return updated;
  }

  private liveToken(token: string) {
    return and(
      eq(guardianConsentRequests.tokenHash, hashToken(token)),
      eq(guardianConsentRequests.status, "pending"),
      gt(guardianConsentRequests.expiresAt, this.now()),
    );
  }

  private async latestRequest(userId: string): Promise<GuardianConsentRequestRow | undefined> {
    const [row] = await this.db
      .select()
      .from(guardianConsentRequests)
      .where(eq(guardianConsentRequests.userId, userId))
      // On equal timestamps (a frozen test clock), prefer the request that is
      // neither superseded nor decided: it is the newest.
      .orderBy(
        desc(guardianConsentRequests.requestedAt),
        sql`${guardianConsentRequests.status} = 'superseded'`,
        sql`${guardianConsentRequests.decidedAt} is not null`,
      )
      .limit(1);
    return row;
  }

  private describe(row: GuardianConsentRequestRow) {
    return {
      guardianEmail: row.guardianEmail,
      requestedAt: row.requestedAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      decidedAt: row.decidedAt?.toISOString() ?? null,
    };
  }

  private consume(rule: RateLimitRuleName, key: string): void {
    const result = this.limiter.consume(rule, key);
    if (result.limited) throw rateLimited(result.retryAfterSeconds);
  }
}
