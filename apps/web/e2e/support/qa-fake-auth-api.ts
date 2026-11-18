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
 */
import { randomUUID } from "node:crypto";
import {
  logInRequestSchema,
  logOutRequestSchema,
  passwordResetConfirmRequestSchema,
  passwordResetRequestSchema,
  refreshRequestSchema,
  resendVerificationRequestSchema,
  signUpRequestSchema,
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
  type: "verify_email" | "password_reset" | "account_exists";
  token?: string;
}

const ACCESS_MS = 15 * 60_000;
const REFRESH_MS = 30 * 24 * 3_600_000;

export class FakeAuthApi {
  readonly accounts = new Map<string, Account>();
  readonly sessions: Session[] = [];
  readonly emails: CapturedEmail[] = [];
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
  ) {
    const account: Account = {
      id: randomUUID(),
      email: email.trim().toLowerCase(),
      password,
      role,
      status,
      createdAt: new Date().toISOString(),
    };
    this.accounts.set(account.email, account);
    return account;
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
      emailVerified: a.status === "active",
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
        const b = parse(signUpRequestSchema);
        if (isErr(b)) return b;
        const existing = this.accounts.get(b.email);
        if (!existing) {
          this.seed(b.email, b.password, "pending_verification");
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
        a.status = "active";
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
        const token = /^Bearer (.+)$/.exec(authorization ?? "")?.[1];
        const s = this.sessions.find((x) => x.access === token && !x.revoked);
        if (!s || s.accessExpiresAt < this.now()) return err(401, "unauthorized");
        const a = [...this.accounts.values()].find((x) => x.id === s.userId)!;
        return [200, { user: this.user(a) }];
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
        a.status = "active";
        for (const s of this.sessions) if (s.userId === a.id) s.revoked = true;
        return [200, { message: "Password changed" }];
      }
      default:
        return err(404, "not_found");
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
