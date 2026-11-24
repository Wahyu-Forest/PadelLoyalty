/**
 * QA (issue #1): an in-browser fake of the auth API, built from the contract
 * in docs/api/auth.md and the Zod schemas in @padelloyalty/shared.
 *
 * It intercepts `{API}/auth/*` and `{API}/health` with `page.route`, keeps
 * accounts, sessions and emailed tokens in memory, and validates every request
 * body with the shared request schemas, so a UI that sends the wrong shape fails
 * the test. Emails are captured (like CapturingMailer) for the verify / reset
 * flows. It lets the UI flows run in CI without a running API, at `/` and under
 * the GitHub Pages base path.
 *
 * Issue #3: sign-up takes a date of birth (validated with `signUpRequestSchemaOn`
 * for today's UTC date); under-18s get `pending_consent` on verification and a
 * `guardian_consent` email to the guardian; `GET /auth/consent`,
 * `POST /auth/consent/request|review|decision` follow docs/api/consent.md.
 */
import { randomUUID } from "node:crypto";
import {
  calendarDateUtc,
  consentDecisionRequestSchema,
  consentRequestRequestSchema,
  consentReviewRequestSchema,
  GUARDIAN_CONSENT_LINK_DAYS,
  needsGuardianConsent,
  signUpRequestSchemaOn,
  type ConsentState,
  logInRequestSchema,
  logOutRequestSchema,
  passwordResetConfirmRequestSchema,
  passwordResetRequestSchema,
  refreshRequestSchema,
  resendVerificationRequestSchema,
  verifyEmailRequestSchema,
  type AccountStatus,
  type ApiErrorCode,
  type AuthUser,
  type UserRole,
} from "@padelloyalty/shared";
import type { Page, Route } from "@playwright/test";

interface Account {
  id: string;
  email: string;
  password: string;
  role: UserRole;
  status: AccountStatus;
  createdAt: string;
  /** #3: null for accounts seeded as "from before #3". */
  dateOfBirth: string | null;
  guardianEmail: string | null;
  needsConsent: boolean;
}
export interface ConsentRequest {
  email: string;
  guardianEmail: string;
  token: string;
  requestedAt: number;
  expiresAt: number;
  status: "pending" | "confirmed" | "declined" | "superseded";
  decidedAt: number | null;
  attested: boolean;
}
interface Session {
  userId: string;
  access: string;
  refresh: string;
  accessExpiresAt: number;
  rotated: Set<string>;
  revoked: boolean;
}
export interface CapturedEmail {
  to: string;
  type: "verify_email" | "password_reset" | "account_exists" | "guardian_consent";
  token?: string;
}

const ACCESS_MS = 15 * 60_000;
const REFRESH_MS = 30 * 24 * 3_600_000;
const CONSENT_MS = GUARDIAN_CONSENT_LINK_DAYS * 24 * 3_600_000;

export class FakeAuthApi {
  readonly accounts = new Map<string, Account>();
  readonly sessions: Session[] = [];
  readonly emails: CapturedEmail[] = [];
  readonly consentRequests: ConsentRequest[] = [];
  readonly requests: {
    method: string;
    path: string;
    body: unknown;
    authorization?: string;
    cookie?: string;
  }[] = [];
  private tokens = new Map<
    string,
    { email: string; type: "verify_email" | "password_reset"; used: boolean }
  >();
  /** Set to make every request fail at the network level (API down). */
  offline = false;
  /** Offset added to the fake clock, to expire access tokens. */
  clockOffsetMs = 0;
  /** Delay before answering, to observe loading states / double submits. */
  delayMs = 0;

  private now() {
    return Date.now() + this.clockOffsetMs;
  }

  /** Adds a ready-made account (bypassing sign-up). */
  seed(
    email: string,
    password: string,
    status: AccountStatus = "active",
    role: UserRole = "member",
    extra: { dateOfBirth?: string; guardianEmail?: string } = {},
  ) {
    const dateOfBirth = extra.dateOfBirth ?? null;
    const needsConsent =
      dateOfBirth !== null && needsGuardianConsent(dateOfBirth, calendarDateUtc(new Date()));
    const account: Account = {
      id: randomUUID(),
      email: email.trim().toLowerCase(),
      password,
      role,
      status,
      createdAt: new Date().toISOString(),
      dateOfBirth,
      guardianEmail: needsConsent ? (extra.guardianEmail?.trim().toLowerCase() ?? null) : null,
      needsConsent,
    };
    this.accounts.set(account.email, account);
    return account;
  }

  /**
   * Adds an under-18 member who verified their email and is waiting for consent
   * (a `guardian_consent` email has gone to `guardian`). Returns the link token.
   */
  seedPendingMinor(email: string, password: string, guardian: string, dateOfBirth: string) {
    const account = this.seed(email, password, "pending_consent", "member", {
      dateOfBirth,
      guardianEmail: guardian,
    });
    return { account, token: this.sendConsent(account) };
  }

  /** Expires every consent link (as if 7 days passed). */
  expireConsentLinks() {
    for (const r of this.consentRequests) r.expiresAt = this.now() - 1;
  }

  private sendConsent(a: Account): string {
    for (const r of this.consentRequests)
      if (r.email === a.email && r.status === "pending") r.status = "superseded";
    const token = `plc_${randomUUID()}`;
    this.consentRequests.push({
      email: a.email,
      guardianEmail: a.guardianEmail!,
      token,
      requestedAt: this.now(),
      expiresAt: this.now() + CONSENT_MS,
      status: "pending",
      decidedAt: null,
      attested: false,
    });
    this.emails.push({ to: a.guardianEmail!, type: "guardian_consent", token });
    return token;
  }

  private consentStatus(a: Account) {
    const latest = [...this.consentRequests].reverse().find((r) => r.email === a.email);
    const iso = (n: number | null | undefined) => (n == null ? null : new Date(n).toISOString());
    let state: ConsentState;
    if (!a.needsConsent) state = "not_required";
    else if (a.status === "pending_verification") state = "awaiting_member_verification";
    else if (a.status === "active") state = "granted";
    else if (!latest) state = "not_sent";
    else if (latest.status === "declined") state = "declined";
    else if (latest.status === "pending" && latest.expiresAt <= this.now()) state = "expired";
    else state = "pending";
    return {
      state,
      guardianEmail: a.needsConsent ? a.guardianEmail : null,
      requestedAt: iso(latest?.requestedAt),
      expiresAt: iso(latest?.expiresAt),
      decidedAt: iso(latest?.decidedAt),
    };
  }

  private liveConsent(token: string) {
    const r = this.consentRequests.find((x) => x.token === token);
    return r && r.status === "pending" && r.expiresAt > this.now() ? r : undefined;
  }

  lastEmail(to: string, type?: CapturedEmail["type"]) {
    return [...this.emails].reverse().find((e) => e.to === to && (!type || e.type === type));
  }

  /** Expires every access token (as if 15 minutes passed). */
  expireAccessTokens() {
    this.clockOffsetMs += ACCESS_MS + 1_000;
  }

  activeSessions(email: string) {
    const account = this.accounts.get(email);
    return this.sessions.filter((s) => s.userId === account?.id && !s.revoked);
  }

  private issueEmailToken(email: string, type: "verify_email" | "password_reset") {
    for (const t of this.tokens.values()) if (t.email === email && t.type === type) t.used = true;
    const token = `${type === "verify_email" ? "v" : "r"}_${randomUUID()}`;
    this.tokens.set(token, { email, type, used: false });
    this.emails.push({ to: email, type, token });
  }

  private user(a: Account): AuthUser {
    return {
      id: a.id,
      email: a.email,
      role: a.role,
      status: a.status,
      emailVerified: a.status !== "pending_verification",
      createdAt: a.createdAt,
    };
  }

  private newSession(a: Account, existing?: Session) {
    const now = this.now();
    const session = existing ?? {
      userId: a.id,
      access: "",
      refresh: "",
      accessExpiresAt: 0,
      rotated: new Set<string>(),
      revoked: false,
    };
    if (existing) session.rotated.add(existing.refresh);
    session.access = `pla_${randomUUID()}`;
    session.refresh = `plr_${randomUUID()}`;
    session.accessExpiresAt = now + ACCESS_MS;
    if (!existing) this.sessions.push(session);
    return {
      user: this.user(a),
      accessToken: session.access,
      accessTokenExpiresAt: new Date(session.accessExpiresAt).toISOString(),
      refreshToken: session.refresh,
      refreshTokenExpiresAt: new Date(now + REFRESH_MS).toISOString(),
    };
  }

  private handle(
    method: string,
    path: string,
    body: unknown,
    authorization?: string,
  ): [number, unknown] {
    const err = (status: number, code: ApiErrorCode, message: string = code) =>
      [status, { error: { code, message } }] as [number, unknown];
    type Schema<T> = {
      safeParse(
        x: unknown,
      ):
        | { success: true; data: T }
        | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } };
    };
    const parse = <T>(schema: Schema<T>): T | [number, unknown] => {
      const r = schema.safeParse(body);
      if (r.success) return r.data;
      const fieldErrors: Record<string, string[]> = {};
      for (const issue of r.error.issues) {
        const key = String(issue.path[0] ?? "_");
        (fieldErrors[key] ??= []).push(issue.message);
      }
      return [
        400,
        { error: { code: "validation_error", message: "Invalid request", fieldErrors } },
      ];
    };
    const isErr = (x: unknown): x is [number, unknown] => Array.isArray(x);
    const accepted: [number, unknown] = [
      202,
      { message: "If the details are right, we've sent you an email." },
    ];

    switch (`${method} ${path}`) {
      case "GET /health":
        return [200, { status: "ok", database: "up", timestamp: new Date().toISOString() }];
      case "POST /auth/signup": {
        const b = parse(signUpRequestSchemaOn(calendarDateUtc(new Date())));
        if (isErr(b)) return b;
        const existing = this.accounts.get(b.email);
        if (!existing) {
          this.seed(b.email, b.password, "pending_verification", "member", {
            dateOfBirth: b.dateOfBirth,
            guardianEmail: b.guardianEmail,
          });
          this.issueEmailToken(b.email, "verify_email");
        } else if (existing.status === "pending_verification") {
          this.issueEmailToken(b.email, "verify_email");
        } else {
          this.emails.push({ to: b.email, type: "account_exists" });
        }
        return accepted;
      }
      case "POST /auth/verify-email": {
        const b = parse(verifyEmailRequestSchema);
        if (isErr(b)) return b;
        const t = this.tokens.get(b.token);
        if (!t || t.used || t.type !== "verify_email") return err(400, "invalid_token");
        t.used = true;
        const a = this.accounts.get(t.email)!;
        this.markVerified(a);
        return [200, { message: "Email verified", accountStatus: a.status }];
      }
      case "POST /auth/verify-email/resend": {
        const b = parse(resendVerificationRequestSchema);
        if (isErr(b)) return b;
        if (this.accounts.get(b.email)?.status === "pending_verification")
          this.issueEmailToken(b.email, "verify_email");
        return accepted;
      }
      case "POST /auth/login": {
        const b = parse(logInRequestSchema);
        if (isErr(b)) return b;
        const a = this.accounts.get(b.email);
        if (!a || a.password !== b.password)
          return err(401, "invalid_credentials", "Email or password is incorrect");
        return [200, this.newSession(a)];
      }
      case "POST /auth/refresh": {
        const b = parse(refreshRequestSchema);
        if (isErr(b)) return b;
        const reused = this.sessions.find((s) => s.rotated.has(b.refreshToken));
        if (reused) {
          reused.revoked = true;
          return err(401, "invalid_refresh_token");
        }
        const s = this.sessions.find((x) => x.refresh === b.refreshToken && !x.revoked);
        if (!s) return err(401, "invalid_refresh_token");
        const a = [...this.accounts.values()].find((x) => x.id === s.userId)!;
        return [200, this.newSession(a, s)];
      }
      case "POST /auth/logout": {
        const b = parse(logOutRequestSchema);
        if (isErr(b)) return b;
        const s = this.sessions.find((x) => x.refresh === b.refreshToken);
        if (s) s.revoked = true;
        return [204, undefined];
      }
      case "GET /auth/me": {
        const a = this.authed(authorization);
        if (!a) return err(401, "unauthorized");
        return [200, { user: this.user(a) }];
      }
      case "GET /auth/consent": {
        const a = this.authed(authorization);
        if (!a) return err(401, "unauthorized");
        return [200, this.consentStatus(a)];
      }
      case "POST /auth/consent/request": {
        const a = this.authed(authorization);
        if (!a) return err(401, "unauthorized");
        const b = parse(consentRequestRequestSchema);
        if (isErr(b)) return b;
        if (!a.needsConsent || a.status === "active")
          return err(409, "consent_not_required", "This account doesn't need consent");
        const target = b.guardianEmail ?? a.guardianEmail!;
        if (target === a.email)
          return [
            400,
            {
              error: {
                code: "validation_error",
                message: "Invalid request",
                fieldErrors: {
                  guardianEmail: ["Your parent or guardian's email must be different from yours"],
                },
              },
            },
          ];
        if (
          this.consentRequests.some(
            (r) => r.email === a.email && r.guardianEmail === target && r.status === "declined",
          )
        )
          return err(409, "guardian_declined", "This guardian declined. Ask someone else.");
        a.guardianEmail = target;
        if (a.status === "pending_consent") this.sendConsent(a);
        return [200, this.consentStatus(a)];
      }
      case "POST /auth/consent/review": {
        const b = parse(consentReviewRequestSchema);
        if (isErr(b)) return b;
        const r = this.liveConsent(b.token);
        if (!r) return err(400, "invalid_token", "This link is invalid or has expired");
        const a = this.accounts.get(r.email)!;
        return [
          200,
          {
            memberEmail: a.email,
            memberDateOfBirth: a.dateOfBirth,
            guardianEmail: r.guardianEmail,
            expiresAt: new Date(r.expiresAt).toISOString(),
          },
        ];
      }
      case "POST /auth/consent/decision": {
        const b = parse(consentDecisionRequestSchema);
        if (isErr(b)) return b;
        const r = this.liveConsent(b.token);
        if (!r) return err(400, "invalid_token", "This link is invalid or has expired");
        r.decidedAt = this.now();
        const a = this.accounts.get(r.email)!;
        if (b.decision === "confirm") {
          r.status = "confirmed";
          r.attested = true;
          a.status = "active";
        } else {
          r.status = "declined";
        }
        return [200, { message: "Thank you", decision: b.decision }];
      }
      case "POST /auth/password-reset/request": {
        const b = parse(passwordResetRequestSchema);
        if (isErr(b)) return b;
        if (this.accounts.has(b.email)) this.issueEmailToken(b.email, "password_reset");
        return accepted;
      }
      case "POST /auth/password-reset/confirm": {
        const b = parse(passwordResetConfirmRequestSchema);
        if (isErr(b)) return b;
        const t = this.tokens.get(b.token);
        if (!t || t.used || t.type !== "password_reset") return err(400, "invalid_token");
        t.used = true;
        const a = this.accounts.get(t.email)!;
        a.password = b.password;
        this.markVerified(a);
        for (const s of this.sessions) if (s.userId === a.id) s.revoked = true;
        return [200, { message: "Password changed" }];
      }
      default:
        return err(404, "not_found");
    }
  }

  private authed(authorization?: string): Account | undefined {
    const token = /^Bearer (.+)$/.exec(authorization ?? "")?.[1];
    const s = this.sessions.find((x) => x.access === token && !x.revoked);
    if (!s || s.accessExpiresAt < this.now()) return undefined;
    return [...this.accounts.values()].find((x) => x.id === s.userId);
  }

  private markVerified(a: Account) {
    if (a.status !== "pending_verification") return;
    const today = calendarDateUtc(new Date(this.now()));
    if (a.dateOfBirth && needsGuardianConsent(a.dateOfBirth, today)) {
      a.status = "pending_consent";
      this.sendConsent(a);
    } else {
      a.status = "active";
    }
  }

  /** Installs the fake on a page. Matches `/auth/*` and `/health` on any origin except the app's. */
  async install(page: Page, appOrigin: string) {
    const handler = async (route: Route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin === appOrigin) return route.fallback();
      const cors = {
        "access-control-allow-origin": request.headers()["origin"] ?? "*",
        "access-control-allow-headers": "authorization, content-type",
        "access-control-allow-methods": "GET, POST, OPTIONS",
      };
      if (this.offline) return route.abort("connectionrefused");
      if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
      let body: unknown = undefined;
      try {
        body = request.postData() ? JSON.parse(request.postData()!) : undefined;
      } catch {
        body = request.postData();
      }
      const authorization = request.headers()["authorization"];
      this.requests.push({
        method: request.method(),
        path: url.pathname,
        body,
        authorization,
        cookie: request.headers()["cookie"],
      });
      if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
      const [status, json] = this.handle(request.method(), url.pathname, body, authorization);
      return route.fulfill({
        status,
        headers: { ...cors, ...(json === undefined ? {} : { "content-type": "application/json" }) },
        body: json === undefined ? "" : JSON.stringify(json),
      });
    };
    await page.route(/\/(auth\/[^?#]*|health)(\?.*)?$/, handler);
  }
}
