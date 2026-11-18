/**
 * Integration test: /health against a real PostgreSQL.
 * Uses TEST_DATABASE_URL from the shell or apps/api/.env. There is no fallback:
 * the test runs migrations, so it only uses a database the developer named.
 */
import { healthResponseSchema } from "@padelloyalty/shared";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createDatabase, isDatabaseReachable, type DatabaseConnection } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrations.js";
import { maskPassword, requireTestDatabaseUrl } from "./support/test-env.js";

let connection: DatabaseConnection;

beforeAll(async () => {
  const TEST_DATABASE_URL = requireTestDatabaseUrl();
  connection = createDatabase(TEST_DATABASE_URL);
  if (!(await isDatabaseReachable(connection.db, 5_000))) {
    await connection.pool.end();
    throw new Error(
      `Cannot reach the test database at ${maskPassword(TEST_DATABASE_URL)}. ` +
        "Start Postgres (`docker compose up -d`) or fix TEST_DATABASE_URL.",
    );
  }
  await runMigrations(connection.db);
});

afterAll(async () => {
  await connection?.pool.end();
});

describe("database migrations", () => {
  it("creates the app_meta table", async () => {
    const result = await connection.db.execute<{ exists: boolean }>(
      sql`select to_regclass('public.app_meta') is not null as exists`,
    );
    expect(result.rows[0]?.exists).toBe(true);
  });
});

describe("GET /health (real PostgreSQL)", () => {
  it("reports the database as up", async () => {
    const app = await buildApp({
      checkDatabase: () => isDatabaseReachable(connection.db),
      corsOrigins: [],
    });
    try {
      const response = await app.inject({ method: "GET", url: "/health" });

      expect(response.statusCode).toBe(200);
      expect(healthResponseSchema.parse(response.json())).toMatchObject({
        status: "ok",
        database: "up",
      });
    } finally {
      await app.close();
    }
  });

  it("reports the database as down when it cannot connect", async () => {
    // Port 1 on localhost: nothing listens there, so the connection is refused.
    const unreachable = createDatabase("postgres://padel:padel@127.0.0.1:1/padelloyalty_test");
    const app = await buildApp({
      checkDatabase: () => isDatabaseReachable(unreachable.db),
      corsOrigins: [],
    });
    try {
      const response = await app.inject({ method: "GET", url: "/health" });

      expect(response.statusCode).toBe(503);
      expect(healthResponseSchema.parse(response.json())).toMatchObject({
        status: "degraded",
        database: "down",
      });
    } finally {
      await app.close();
      await unreachable.pool.end();
    }
  });
});
