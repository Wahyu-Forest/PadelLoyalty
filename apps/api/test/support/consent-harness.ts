/**
 * QA harness for the guardian consent tests (issue #3).
 *
 * Built only on the documented contract: docs/api/consent.md, docs/api/auth.md
 * and the shared Zod schemas. The one table it reads is
 * `guardian_consent_requests`, which the contract documents as the auditable
 * consent record ("Consent record (audit)").
 *
 * Every test uses fresh random emails, so files share the QA database without
 * truncating tables.
 */
import {
  consentStatusResponseSchema,
  verifyEmailResponseSchema,
  type ConsentStatusResponse,
} from "@padelloyalty/shared";
import { sql } from "drizzle-orm";
import type { LightMyRequestResponse } from "fastify";
import { expect } from "vitest";
import { requireActiveAccount } from "../../src/auth/routes.js";
import type { DatabaseConnection } from "../../src/db/client.js";
import { tokenFromLink } from "../../src/email/mailer.js";
import {
  type CallOptions,
  type Harness,
  type HarnessOptions,
  logIn,
  makeHarness,
  PASSWORD,
  post,
  uniqueEmail,
} from "./auth-harness.js";

/** A route that needs a fully active account, registered the way consent.md says. */
export const PROTECTED_PATH = "/qa/member-only";

export const DAY_MS = 24 * 60 * 60 * 1000;
export const CONSENT_LINK_MS = 7 * DAY_MS;

/** A fixed "now" for most tests: midday UTC, far from any date boundary. */
export const FIXED_NOW = "2026-11-24T12:00:00.000Z";

export async function makeConsentHarness(
  connection: DatabaseConnection,
  options: HarnessOptions & { now?: string } = {},
): Promise<Harness> {
  const h = await makeHarness(connection, options);
  h.clock.set(options.now ?? FIXED_NOW);
  h.app.get(PROTECTED_PATH, { preHandler: requireActiveAccount(h.app.authService!) }, async () => ({
    ok: true,
  }));
  await h.app.ready();
  return h;
}

/** `YYYY-MM-DD` of the harness clock in UTC. */
export function todayUtc(h: Harness): string {
  return h.clock.now().toISOString().slice(0, 10);
}

/** `YYYY-MM-DD` that is `years` years before today (UTC), plus `days` days. */
export function dobYearsAgo(h: Harness, years: number, days = 0): string {
  const now = h.clock.now();
  const d = new Date(
    Date.UTC(now.getUTCFullYear() - years, now.getUTCMonth(), now.getUTCDate() + days),
  );
  return d.toISOString().slice(0, 10);
}

export function guardianEmail(): string {
  return uniqueEmail("guardian");
}

export function get(
  h: Harness,
  url: string,
  token?: string,
  options: CallOptions = {},
): Promise<LightMyRequestResponse> {
  return h.app.inject({
    method: "GET",
    url,
    remoteAddress: options.ip ?? "203.0.113.10",
    headers: {
      ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
}

export interface MinorOptions {
  email?: string;
  guardian?: string;
  dateOfBirth?: string;
  ip?: string;
}

/** Signs up an under-18 member (15 years old unless `dateOfBirth` is given). */
export async function signUpMinor(h: Harness, options: MinorOptions = {}) {
  const email = options.email ?? uniqueEmail("junior");
  const guardian = options.guardian ?? guardianEmail();
  const dateOfBirth = options.dateOfBirth ?? dobYearsAgo(h, 15);
  const response = await post(
    h.app,
    "/auth/signup",
    { email, password: PASSWORD, dateOfBirth, guardianEmail: guardian },
    { ip: options.ip },
  );
  expect(response.statusCode, response.body).toBe(202);
  return { email, guardian, dateOfBirth };
}

/** Verifies the member's own email from the captured link; returns the response body. */
export async function verifyMember(h: Harness, email: string) {
  const message = h.mailer.lastTo(email, "verify_email");
  expect(message, `no verify_email to ${email}`).toBeTruthy();
  const response = await post(h.app, "/auth/verify-email", {
    token: tokenFromLink(message!.link!),
  });
  expect(response.statusCode, response.body).toBe(200);
  return verifyEmailResponseSchema.parse(response.json());
}

/** The latest consent link emailed to `guardian` (fails if none). */
export function consentToken(h: Harness, guardian: string): string {
  const message = h.mailer.lastTo(guardian, "guardian_consent" as never);
  expect(message, `no guardian_consent email to ${guardian}`).toBeTruthy();
  return tokenFromLink(message!.link!);
}

export function consentEmails(h: Harness, to?: string) {
  return h.mailer.messages.filter(
    (m) => (m.type as string) === "guardian_consent" && (to === undefined || m.to === to),
  );
}

/** Signs up, verifies and logs in an under-18 member; the guardian has a link. */
export async function pendingMinor(h: Harness, options: MinorOptions = {}) {
  const minor = await signUpMinor(h, options);
  const verified = await verifyMember(h, minor.email);
  expect(verified.accountStatus).toBe("pending_consent");
  const session = await logIn(h, minor.email);
  return { ...minor, session, token: consentToken(h, minor.guardian) };
}

export async function getConsent(h: Harness, accessToken: string): Promise<ConsentStatusResponse> {
  const response = await get(h, "/auth/consent", accessToken);
  expect(response.statusCode, response.body).toBe(200);
  return consentStatusResponseSchema.parse(response.json());
}

export function requestConsent(
  h: Harness,
  accessToken: string,
  body: Record<string, unknown> = {},
  options: CallOptions = {},
) {
  return post(h.app, "/auth/consent/request", body, { ...options, token: accessToken });
}

export function review(h: Harness, token: unknown, options: CallOptions = {}) {
  return post(h.app, "/auth/consent/review", { token }, options);
}

export function confirm(h: Harness, token: unknown, options: CallOptions = {}) {
  return post(
    h.app,
    "/auth/consent/decision",
    { token, decision: "confirm", isParentOrGuardian: true },
    options,
  );
}

export function decline(h: Harness, token: unknown, options: CallOptions = {}) {
  return post(h.app, "/auth/consent/decision", { token, decision: "decline" }, options);
}

export function memberOnly(h: Harness, accessToken?: string) {
  return get(h, PROTECTED_PATH, accessToken);
}

export async function meStatus(h: Harness, accessToken: string): Promise<string> {
  const response = await get(h, "/auth/me", accessToken);
  expect(response.statusCode, response.body).toBe(200);
  return (response.json() as { user: { status: string } }).user.status;
}

export interface ConsentRow {
  user_id: string;
  guardian_email: string;
  member_date_of_birth: string;
  method: string;
  status: string;
  requested_at: Date;
  expires_at: Date;
  decided_at: Date | null;
  decided_ip: string | null;
  decided_user_agent: string | null;
  guardian_attested: boolean | null;
  superseded_at: Date | null;
  token_hash: string;
  dob_text: string;
  [column: string]: unknown;
}

/**
 * The member's consent records (documented audit table), oldest first.
 * Tests advance the clock between sends so `requested_at` orders them.
 */
export async function consentRows(
  connection: DatabaseConnection,
  memberEmail: string,
): Promise<ConsentRow[]> {
  const result = await connection.db.execute(sql`
    select r.*, r.member_date_of_birth::text as dob_text
    from guardian_consent_requests r
    join users u on u.id = r.user_id
    where u.email = ${memberEmail}
    order by r.requested_at
  `);
  return result.rows as unknown as ConsentRow[];
}
