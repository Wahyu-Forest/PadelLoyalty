/**
 * Environment handling for the API test suite.
 *
 * Vitest does not read `.env` files into `process.env`, so `vitest.config.ts`
 * uses `readDotEnv` to load `apps/api/.env` (shell variables win). The
 * integration tests then call `requireTestDatabaseUrl`, which never falls back
 * to a default: they run migrations, so they only touch a database the
 * developer named explicitly.
 */
import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";

/**
 * Returns the variables in `envFile` that are not already set in `shellEnv`,
 * so a value exported in the shell (or by CI) overrides the file.
 * A missing file yields `{}`.
 */
export function readDotEnv(
  envFile: string,
  shellEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  if (!existsSync(envFile)) return {};
  const fromFile = parseEnv(readFileSync(envFile, "utf8")) as Record<string, string>;
  return Object.fromEntries(
    Object.entries(fromFile).filter(([key]) => shellEnv[key] === undefined),
  );
}

/** Hides the password in a connection string, for error messages. */
export function maskPassword(url: string): string {
  return url.replace(/:[^:@/]*@/, ":***@");
}

/**
 * The database the integration tests may migrate. Throws when
 * TEST_DATABASE_URL is unset or blank, or when it is the same as DATABASE_URL.
 */
export function requireTestDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.TEST_DATABASE_URL?.trim();
  if (!url) {
    throw new Error(
      "TEST_DATABASE_URL is not set. The API integration tests run migrations on it, so they " +
        "need a database you chose: set it in apps/api/.env (see apps/api/.env.example) or in the shell.",
    );
  }
  if (env.DATABASE_URL !== undefined && url === env.DATABASE_URL.trim()) {
    throw new Error(
      `TEST_DATABASE_URL is the same as DATABASE_URL (${maskPassword(url)}). ` +
        "Point it at a separate test database so the tests don't touch development data.",
    );
  }
  return url;
}
