import { loadEnv } from "../env.js";
import { createDatabase } from "./client.js";
import { runMigrations } from "./migrations.js";

const { DATABASE_URL } = loadEnv();
const { db, pool } = createDatabase(DATABASE_URL);

try {
  await runMigrations(db);
  console.log("Migrations applied.");
} catch (error) {
  console.error("Migration failed:", error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
