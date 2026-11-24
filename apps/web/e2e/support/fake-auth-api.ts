/**
 * In-browser stand-in for the auth API (docs/api/auth.md), installed with
 * Playwright routes so the e2e suite runs against the static export without a
 * server. Requests are parsed and responses built with the shared Zod schemas,
 * so the fake cannot drift from the contract without failing.
 * The real API is covered by apps/api/test/auth.*.db.test.ts.
 */
import {
  authSessionResponseSchema,
  calendarDateUtc,
  consentDecisionRequestSchema,
  consentDecisionResponseSchema,
  consentRequestRequestSchema,
  consentReviewRequestSchema,
  consentReviewResponseSchema,
  consentStatusResponseSchema,
  needsGuardianConsent,
  logInRequestSchema,
  logOutRequestSchema,
  meResponseSchema,
  messageResponseSchema,
  passwordResetConfirmRequestSchema,
  passwordResetRequestSchema,
  refreshRequestSchema,
  resendVerificationRequestSchema,
  signUpRequestSchemaOn,
  verifyEmailRequestSchema,
  verifyEmailResponseSchema,
  type ApiErrorCode,
  type AuthUser,
  type ConsentStatusResponse,
} from "@padelloyalty/shared";
import type { Page, Route } from "@playwright/test";
import { z } from "zod";
import { resolveApiUrl } from "../../src/lib/config";

export const API_URL = resolveApiUrl(process.env.NEXT_PUBLIC_API_URL) ?? "http://localhost:4000";

interface Account {
  user: AuthUser;
  password: string;
  dateOfBirth: string;
  guardianEmail: string | null;
  /** Guardian consent (#3): the latest request, as the member's status shows it. */
  consent: Omit<ConsentStatusResponse, "guardianEmail"> | null;
  declinedBy: Set<string>;
}

interface Email {
  to: string;
  type: "verify_email" | "password_reset" | "guardian_consent";
  token: string;
  /** For guardian_consent: the member asking. */
  member?: string;
}

const today = () => calendarDateUtc(new Date());

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-expose-headers": "retry-after",
};

export class FakeAuthApi {
  readonly accounts = new Map<string, Account>();
  readonly emails: Email[] = [];
  /** Every call the app made, e.g. "POST /auth/login". */
  readonly calls: string[] = [];
  /** Force the next response for a path, e.g. a 429. */
  readonly overrides = new Map<
    string,
    { status: number; body: unknown; headers?: Record<string, string> }
  >();
  private readonly sessions = new Map<string, { email: string; access: string }>();
  private readonly linkTokens = new Map<string, Email & { used: boolean }>();
  private counter = 0;

  async install(page: Page): Promise<void> {
    await page.route(`${API_URL}/**`, (route) => this.handle(route));
  }

  /** Creates an account directly, verified or not. */
  addAccount(
    email: string,
    password: string,
    verified = true,
    extra: { dateOfBirth?: string; guardianEmail?: string | null } = {},
  ): Account {
    const account: Account = {
      password,
      dateOfBirth: extra.dateOfBirth ?? "1990-04-15",
      guardianEmail: extra.guardianEmail ?? null,
      consent: null,
      declinedBy: new Set(),
      user: {
        id: crypto.randomUUID(),
        email,
        role: "member",
        status: verified ? "active" : "pending_verification",
        emailVerified: verified,
        createdAt: new Date().toISOString(),
      },
    };
    this.accounts.set(email, account);
    return account;
  }

  /** An under-18 member who verified their email; their guardian has been emailed (#3). */
  addPendingMinor(email: string, password: string, dateOfBirth: string, guardianEmail: string) {
    const account = this.addAccount(email, password, true, { dateOfBirth, guardianEmail });
    account.user = { ...account.user, status: "pending_consent" };
    this.sendConsent(account);
    return account;
  }

  /** The app path of the latest emailed link, e.g. "verify-email/#token=…". */
  linkPath(email: string, type: Email["type"]): string {
    const message = this.emails.findLast((e) => e.to === email && e.type === type);
    if (!message) throw new Error(`no ${type} email to ${email}`);
    const page =
      type === "verify_email"
        ? "verify-email"
        : type === "password_reset"
          ? "reset-password"
          : "guardian-consent";
    return `${page}/#token=${message.token}`;
  }

  private async handle(route: Route): Promise<void> {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "OPTIONS") {
      return route.fulfill({ status: 204, headers: CORS });
    }
    this.calls.push(`${request.method()} ${path}`);
    const override = this.overrides.get(path);
    if (override) {
      this.overrides.delete(path);
      return this.reply(route, override.status, override.body, override.headers);
    }
    let body: unknown = {};
    try {
      body = request.postDataJSON() ?? {};
    } catch {
      body = {};
    }
    const [status, response] = this.respond(request.method(), path, body, request.headers());
    return this.reply(route, status, response);
  }

  private reply(route: Route, status: number, body: unknown, headers: Record<string, string> = {}) {
    return route.fulfill({
      status,
      headers: { ...CORS, ...headers },
      contentType: "application/json",
      body: status === 204 ? "" : JSON.stringify(body),
    });
  }

  private respond(
    method: string,
    path: string,
    body: unknown,
    headers: Record<string, string>,
  ): [number, unknown] {
    const parse = <T extends z.ZodType>(schema: T) => {
      const result = schema.safeParse(body);
      if (!result.success) {
        throw Object.assign(new Error("validation"), {
          reply: [
            400,
            error(
              "validation_error",
              "Some fields are missing or invalid.",
              z.flattenError(result.error).fieldErrors,
            ),
          ],
        });
      }
      return result.data as z.output<T>;
    };

    try {
      switch (`${method} ${path}`) {
        case "POST /auth/signup": {
          const { email, password, dateOfBirth, guardianEmail } = parse(
            signUpRequestSchemaOn(today()),
          );
          if (!this.accounts.has(email)) {
            this.addAccount(email, password, false, {
              dateOfBirth,
              guardianEmail: needsGuardianConsent(dateOfBirth, today())
                ? (guardianEmail ?? null)
                : null,
            });
            this.sendLink(email, "verify_email");
          }
          return [
            202,
            messageResponseSchema.parse({ message: "Check your inbox to verify your email." }),
          ];
        }
        case "POST /auth/verify-email": {
          const { token } = parse(verifyEmailRequestSchema);
          const account = this.useLink(token, "verify_email");
          if (!account)
            return [400, error("invalid_token", "This link is invalid or has expired.")];
          const minor = needsGuardianConsent(account.dateOfBirth, today());
          account.user = {
            ...account.user,
            status: minor ? "pending_consent" : "active",
            emailVerified: true,
          };
          if (minor) this.sendConsent(account);
          return [
            200,
            verifyEmailResponseSchema.parse({
              message: minor
                ? "Your email is verified. We've emailed your parent or guardian to ask for their consent."
                : "Your email is verified.",
              accountStatus: account.user.status,
            }),
          ];
        }
        case "POST /auth/verify-email/resend": {
          const { email } = parse(resendVerificationRequestSchema);
          if (this.accounts.get(email)?.user.emailVerified === false)
            this.sendLink(email, "verify_email");
          return [
            202,
            messageResponseSchema.parse({ message: "If needed, we've sent a new link." }),
          ];
        }
        case "POST /auth/login": {
          const { email, password } = parse(logInRequestSchema);
          const account = this.accounts.get(email);
          if (!account || account.password !== password) {
            return [401, error("invalid_credentials", "Email or password is incorrect.")];
          }
          return [200, this.newSession(email)];
        }
        case "POST /auth/refresh": {
          const { refreshToken } = parse(refreshRequestSchema);
          const session = this.sessions.get(refreshToken);
          if (!session) return [401, error("invalid_refresh_token", "Your session has ended.")];
          this.sessions.delete(refreshToken);
          return [200, this.newSession(session.email)];
        }
        case "POST /auth/logout": {
          const { refreshToken } = parse(logOutRequestSchema);
          this.sessions.delete(refreshToken);
          return [204, null];
        }
        case "GET /auth/me": {
          const account = this.authenticated(headers);
          if (!account) return [401, error("unauthorized", "You need to log in to do that.")];
          return [200, meResponseSchema.parse({ user: account.user })];
        }
        case "GET /auth/consent": {
          const account = this.authenticated(headers);
          if (!account) return [401, error("unauthorized", "You need to log in to do that.")];
          return [200, this.consentStatus(account)];
        }
        case "POST /auth/consent/request": {
          const account = this.authenticated(headers);
          if (!account) return [401, error("unauthorized", "You need to log in to do that.")];
          const { guardianEmail } = parse(consentRequestRequestSchema);
          const status = account.user.status;
          if (status === "active" || account.guardianEmail === null) {
            return [409, error("consent_not_required", "This account doesn't need consent.")];
          }
          const target = guardianEmail ?? account.guardianEmail;
          if (target === account.user.email) {
            return [
              400,
              error("validation_error", "Some fields are missing or invalid.", {
                guardianEmail: ["Your parent or guardian's email must be different from yours"],
              }),
            ];
          }
          if (account.declinedBy.has(target)) {
            return [
              409,
              error("guardian_declined", "This parent or guardian has already declined."),
            ];
          }
          account.guardianEmail = target;
          if (status === "pending_consent") this.sendConsent(account);
          return [200, this.consentStatus(account)];
        }
        case "POST /auth/consent/review": {
          const { token } = parse(consentReviewRequestSchema);
          const link = this.liveConsentLink(token);
          const account = link?.member ? this.accounts.get(link.member) : undefined;
          if (!link || !account || !account.consent) {
            return [400, error("invalid_token", "This consent link is invalid or has expired.")];
          }
          return [
            200,
            consentReviewResponseSchema.parse({
              memberEmail: account.user.email,
              memberDateOfBirth: account.dateOfBirth,
              guardianEmail: link.to,
              expiresAt: account.consent.expiresAt,
            }),
          ];
        }
        case "POST /auth/consent/decision": {
          const { token, decision } = parse(consentDecisionRequestSchema);
          const link = this.liveConsentLink(token);
          const account = link?.member ? this.accounts.get(link.member) : undefined;
          if (!link || !account || !account.consent) {
            return [400, error("invalid_token", "This consent link is invalid or has expired.")];
          }
          link.used = true;
          const decidedAt = new Date().toISOString();
          if (decision === "confirm") {
            account.user = { ...account.user, status: "active" };
            account.consent = { ...account.consent, state: "granted", decidedAt };
          } else {
            account.declinedBy.add(link.to);
            account.consent = { ...account.consent, state: "declined", decidedAt };
          }
          return [
            200,
            consentDecisionResponseSchema.parse({
              decision,
              message:
                decision === "confirm"
                  ? "Thank you. You've given consent, and the account is now active."
                  : "You've declined. The account stays inactive. Thank you for letting us know.",
            }),
          ];
        }
        case "POST /auth/password-reset/request": {
          const { email } = parse(passwordResetRequestSchema);
          if (this.accounts.has(email)) this.sendLink(email, "password_reset");
          return [
            202,
            messageResponseSchema.parse({
              message: "If this email has an account, we've sent a link.",
            }),
          ];
        }
        case "POST /auth/password-reset/confirm": {
          const { token, password } = parse(passwordResetConfirmRequestSchema);
          const account = this.useLink(token, "password_reset");
          if (!account)
            return [400, error("invalid_token", "This link is invalid or has expired.")];
          account.password = password;
          for (const [refresh, s] of this.sessions)
            if (s.email === account.user.email) this.sessions.delete(refresh);
          return [200, messageResponseSchema.parse({ message: "Your password has been changed." })];
        }
        default:
          return [404, error("not_found", "Not found.")];
      }
    } catch (thrown) {
      const reply = (thrown as { reply?: [number, unknown] }).reply;
      if (reply) return reply;
      throw thrown;
    }
  }

  private sendLink(email: string, type: Email["type"]) {
    const token = `ple_${type}_${++this.counter}`;
    // A new link replaces older unused ones of the same type.
    for (const link of this.linkTokens.values())
      if (link.to === email && link.type === type) link.used = true;
    this.linkTokens.set(token, { to: email, type, token, used: false });
    this.emails.push({ to: email, type, token });
  }

  /** Emails the member's guardian a consent link; older links for this member stop working. */
  private sendConsent(account: Account) {
    const guardian = account.guardianEmail;
    if (!guardian) return;
    const member = account.user.email;
    for (const link of this.linkTokens.values())
      if (link.type === "guardian_consent" && link.member === member) link.used = true;
    const token = `plc_${++this.counter}`;
    const email: Email = { to: guardian, type: "guardian_consent", token, member };
    this.linkTokens.set(token, { ...email, used: false });
    this.emails.push(email);
    const now = Date.now();
    account.consent = {
      state: "pending",
      requestedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 7 * 86_400_000).toISOString(),
      decidedAt: null,
    };
  }

  private liveConsentLink(token: string) {
    const link = this.linkTokens.get(token);
    return link && !link.used && link.type === "guardian_consent" ? link : undefined;
  }

  private consentStatus(account: Account) {
    const none = { requestedAt: null, expiresAt: null, decidedAt: null };
    if (account.guardianEmail === null) {
      return consentStatusResponseSchema.parse({
        state: "not_required",
        guardianEmail: null,
        ...none,
      });
    }
    if (account.user.status === "pending_verification") {
      return consentStatusResponseSchema.parse({
        state: "awaiting_member_verification",
        guardianEmail: account.guardianEmail,
        ...none,
      });
    }
    return consentStatusResponseSchema.parse({
      ...(account.consent ?? { state: "not_sent", ...none }),
      guardianEmail: account.guardianEmail,
    });
  }

  /** The logged-in account for a request's bearer token (used by the clubs fake, #56). */
  authenticated(headers: Record<string, string>): Account | undefined {
    const access = /^Bearer (.+)$/.exec(headers.authorization ?? "")?.[1];
    const session = [...this.sessions.values()].find((s) => s.access === access);
    return session && this.accounts.get(session.email);
  }

  private useLink(token: string, type: Email["type"]): Account | undefined {
    const link = this.linkTokens.get(token);
    if (!link || link.used || link.type !== type) return undefined;
    link.used = true;
    return this.accounts.get(link.to);
  }

  private newSession(email: string) {
    const account = this.accounts.get(email);
    if (!account) throw new Error("no account");
    const n = ++this.counter;
    const access = `pla_${n}`;
    const refresh = `plr_${n}`;
    this.sessions.set(refresh, { email, access });
    const now = Date.now();
    return authSessionResponseSchema.parse({
      user: account.user,
      accessToken: access,
      accessTokenExpiresAt: new Date(now + 15 * 60_000).toISOString(),
      refreshToken: refresh,
      refreshTokenExpiresAt: new Date(now + 30 * 86_400_000).toISOString(),
    });
  }
}

function error(
  code: ApiErrorCode,
  message: string,
  fieldErrors?: Record<string, string[] | undefined>,
) {
  const clean = fieldErrors
    ? Object.fromEntries(Object.entries(fieldErrors).filter((e): e is [string, string[]] => !!e[1]))
    : undefined;
  return { error: { code, message, ...(clean ? { fieldErrors: clean } : {}) } };
}
