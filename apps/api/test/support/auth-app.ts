/**
 * Helpers for auth integration tests against the real test database.
 * See docs/api/auth.md ("Testing hooks").
 */
import { sql } from "drizzle-orm";
import { buildApp, type AuthOptions } from "../../src/app.js";
import {
  createDatabase,
  isDatabaseReachable,
  type DatabaseConnection,
} from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrations.js";
import { CapturingMailer, tokenFromLink, type EmailType } from "../../src/email/mailer.js";
import { maskPassword, requireTestDatabaseUrl } from "./test-env.js";

export const APP_URL = "http://app.test/base";
export const PASSWORD = "correct horse battery";
/** An adult's date of birth. Sign-up requires one since #3. */
export const ADULT_DOB = "1990-04-15";

/**
 * Sign-up needs a date of birth since #3. The #1 tests predate it, so a
 * sign-up body without `dateOfBirth` gets an adult one (bodies that are not
 * plain objects are sent as they are).
 */
export function withAdultDob(url: string, payload: unknown): unknown {
  if (url !== "/auth/signup" || payload === null || typeof payload !== "object") return payload;
  if (Array.isArray(payload) || "dateOfBirth" in payload) return payload;
  return { dateOfBirth: ADULT_DOB, ...payload };
}

/** Connects to TEST_DATABASE_URL and applies migrations. */
export async function connectTestDatabase(): Promise<DatabaseConnection> {
  const url = requireTestDatabaseUrl();
  const connection = createDatabase(url);
  if (!(await isDatabaseReachable(connection.db, 5_000))) {
    await connection.pool.end();
    throw new Error(`Cannot reach the test database at ${maskPassword(url)}.`);
  }
  await runMigrations(connection.db);
  return connection;
}

export async function resetAuthTables(connection: DatabaseConnection): Promise<void> {
  await connection.db.execute(sql`truncate table email_tokens, sessions, users cascade`);
}

/** A controllable clock: starts at the real time, moves only when advanced. */
export class TestClock {
  current = new Date();
  now = () => new Date(this.current.getTime());
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export type TestApp = Awaited<ReturnType<typeof buildAuthApp>>;

export async function buildAuthApp(
  connection: DatabaseConnection,
  overrides: Partial<Omit<AuthOptions, "db" | "mailer" | "appUrl" | "now">> = {},
) {
  const mailer = new CapturingMailer();
  const clock = new TestClock();
  const app = await buildApp({
    checkDatabase: async () => true,
    corsOrigins: ["https://wahyu-forest.github.io"],
    auth: { db: connection.db, mailer, appUrl: APP_URL, now: clock.now, ...overrides },
  });

  const post = (url: string, payload: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method: "POST", url, payload: withAdultDob(url, payload) as object, headers });

  const me = (accessToken: string) =>
    app.inject({
      method: "GET",
      url: "/auth/me",
      headers: { authorization: `Bearer ${accessToken}` },
    });

  const tokenFor = (email: string, type: EmailType) => {
    const message = mailer.lastTo(email, type);
    if (!message?.link) throw new Error(`No ${type} email to ${email}`);
    return tokenFromLink(message.link);
  };

  /** Signs up and verifies, returning the login response body. */
  const signUpVerified = async (email: string, password = PASSWORD) => {
    await post("/auth/signup", { email, password });
    await post("/auth/verify-email", { token: tokenFor(email, "verify_email") });
    const login = await post("/auth/login", { email, password });
    if (login.statusCode !== 200) throw new Error(`login failed: ${login.body}`);
    return login.json() as {
      accessToken: string;
      refreshToken: string;
      user: { id: string; status: string };
    };
  };

  return { app, mailer, clock, post, me, tokenFor, signUpVerified };
}
