/**
 * Promotes an existing, email-verified account to admin (#56):
 *
 *   pnpm --filter @padelloyalty/api admin:create someone@example.com
 *
 * Uses DATABASE_URL (from apps/api/.env or the shell).
 */
import { createDatabase } from "../db/client.js";
import { loadEnv } from "../env.js";
import { describePromotion, promoteToAdmin } from "./promote.js";

const email = process.argv[2];
if (!email || process.argv.length > 3) {
  console.error("Usage: pnpm --filter @padelloyalty/api admin:create <email>");
  process.exit(2);
}

const { DATABASE_URL } = loadEnv();
const { db, pool } = createDatabase(DATABASE_URL);
try {
  const { ok, message } = describePromotion(await promoteToAdmin(db, email));
  (ok ? console.log : console.error)(message);
  process.exitCode = ok ? 0 : 1;
} catch (error) {
  console.error("Could not promote the account:", error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
