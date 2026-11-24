/**
 * QA harness for the auth integration tests (issue #1).
 *
 * Uses only the documented contract (docs/api/auth.md): `buildApp({ auth })`,
 * `CapturingMailer`, `tokenFromLink`, the HTTP endpoints and the shared Zod
 * schemas. It never reads auth tables directly, so the tests do not depend on
 * how the API stores accounts, sessions or tokens.
 *
 * Every test uses fresh random email addresses, so the files can share one
 * test database without truncating tables between tests.
 */
import { randomUUID } from "node:crypto";
import {
  apiErrorResponseSchema,
  authSessionResponseSchema,
  type ApiErrorCode,
  type AuthSessionResponse,
} from "@padelloyalty/shared";
import type { LightMyRequestResponse } from "fastify";
import { expect } from "vitest";
import { buildApp } from "../../src/app.js";
import {
  createDatabase,
  isDatabaseReachable,
  type DatabaseConnection,
} from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrations.js";
import { CapturingMailer, tokenFromLink } from "../../src/email/mailer.js";
import { withAdultDob } from "./auth-app.js";
import { maskPassword, requireTestDatabaseUrl } from "./test-env.js";

export const APP_URL = "http://app.test";
export const PASSWORD = "correct horse battery";

export type App = Awaited<ReturnType<typeof buildApp>>;
type AuthOptions = NonNullable<Parameters<typeof buildApp>[0]["auth"]>;
export type RateLimitOverrides = AuthOptions["rateLimits"];

/** Opens the test database and runs migrations. Call once per file in beforeAll. */
export async function openTestDatabase(): Promise<DatabaseConnection> {
  const url = requireTestDatabaseUrl();
  const connection = createDatabase(url);
  if (!(await isDatabaseReachable(connection.db, 5_000))) {
    await connection.pool.end();
    throw new Error(`Cannot reach the test database at ${maskPassword(url)}.`);
  }
  await runMigrations(connection.db);
  return connection;
}

/** A controllable clock for expiry tests. */
export class TestClock {
  private current = new Date();
  now = (): Date => new Date(this.current.getTime());
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export interface Harness {
  app: App;
  mailer: CapturingMailer;
  clock: TestClock;
}

export interface HarnessOptions {
  /** `false` (default here) disables rate limits; pass overrides or `undefined` for defaults. */
  rateLimits?: RateLimitOverrides | "defaults";
  appUrl?: string;
  corsOrigins?: string[];
}

export async function makeHarness(
  connection: DatabaseConnection,
  options: HarnessOptions = {},
): Promise<Harness> {
  const mailer = new CapturingMailer();
  const clock = new TestClock();
  const rateLimits = options.rateLimits === undefined ? false : options.rateLimits;
  const app = await buildApp({
    checkDatabase: async () => true,
    corsOrigins: options.corsOrigins ?? [],
    auth: {
      db: connection.db,
      mailer,
      appUrl: options.appUrl ?? APP_URL,
      now: clock.now,
      ...(rateLimits === "defaults" ? {} : { rateLimits }),
    },
  });
  return { app, mailer, clock };
}

export function uniqueEmail(tag = "qa"): string {
  return `${tag}-${randomUUID()}@example.com`;
}

export interface CallOptions {
  ip?: string;
  token?: string;
  headers?: Record<string, string>;
}

export function post(
  app: App,
  url: string,
  body: unknown,
  options: CallOptions = {},
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: "POST",
    url,
    // #3: sign-up bodies without a date of birth get an adult one.
    payload: withAdultDob(url, body) as object,
    remoteAddress: options.ip ?? "203.0.113.10",
    headers: {
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...options.headers,
    },
  });
}

export function getMe(
  app: App,
  token: string | undefined,
  options: CallOptions = {},
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: "GET",
    url: "/auth/me",
    remoteAddress: options.ip ?? "203.0.113.10",
    headers: {
      ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
}

/** Asserts an error response: status, contract-shaped body and code. */
export function expectApiError(
  response: LightMyRequestResponse,
  status: number,
  code: ApiErrorCode,
): ReturnType<typeof apiErrorResponseSchema.parse> {
  expect(response.statusCode, response.body).toBe(status);
  const parsed = apiErrorResponseSchema.safeParse(response.json());
  expect(parsed.success, `error body does not match the contract: ${response.body}`).toBe(true);
  expect(parsed.data?.error.code).toBe(code);
  return parsed.data!;
}

export function expectSession(response: LightMyRequestResponse): AuthSessionResponse {
  expect(response.statusCode, response.body).toBe(200);
  return authSessionResponseSchema.parse(response.json());
}

/** Last token emailed to `email` of the given type. Fails if there is none. */
export function lastToken(
  mailer: CapturingMailer,
  email: string,
  type: "verify_email" | "password_reset",
): string {
  const message = mailer.lastTo(email, type);
  expect(message, `no ${type} email captured for ${email}`).toBeTruthy();
  return tokenFromLink(message!.link!);
}

export async function signUp(
  h: Harness,
  email: string,
  password = PASSWORD,
  options?: CallOptions,
) {
  const response = await post(h.app, "/auth/signup", { email, password }, options);
  expect(response.statusCode, response.body).toBe(202);
  return response;
}

export async function verify(h: Harness, email: string): Promise<void> {
  const token = lastToken(h.mailer, email, "verify_email");
  const response = await post(h.app, "/auth/verify-email", { token });
  expect(response.statusCode, response.body).toBe(200);
}

export async function logIn(
  h: Harness,
  email: string,
  password = PASSWORD,
  options?: CallOptions,
): Promise<AuthSessionResponse> {
  return expectSession(await post(h.app, "/auth/login", { email, password }, options));
}

/** Signs up, verifies and logs in a fresh member. */
export async function activeMember(h: Harness, password = PASSWORD) {
  const email = uniqueEmail();
  await signUp(h, email, password);
  await verify(h, email);
  const session = await logIn(h, email, password);
  return { email, password, session };
}

export { tokenFromLink };
