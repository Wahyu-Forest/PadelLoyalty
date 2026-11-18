import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

export type Database = NodePgDatabase<typeof schema>;

export interface DatabaseConnection {
  db: Database;
  pool: pg.Pool;
}

export function createDatabase(databaseUrl: string): DatabaseConnection {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 10,
    connectionTimeoutMillis: 2_000,
  });
  // An idle client losing its connection must not crash the process;
  // the next query will reconnect or fail and be reported by /health.
  pool.on("error", () => {});
  const db = drizzle({ client: pool, schema, casing: "snake_case" });
  return { db, pool };
}

/** Returns true if PostgreSQL answers a trivial query within `timeoutMs`. */
export async function isDatabaseReachable(db: Database, timeoutMs = 2_000): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const query = db.execute(sql`select 1`).then(
    () => true,
    () => false,
  );
  try {
    return await Promise.race([query, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
