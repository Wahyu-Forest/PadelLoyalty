/**
 * Development helper (#6): gives an account points, since no earn feature
 * exists yet. Writes one `adjustment` entry through PointsLedger to
 * DATABASE_URL (a negative amount debits). Not an endpoint; refuses to run with NODE_ENV=production.
 *
 *   pnpm --filter @padelloyalty/api points:credit <email> <amount> [reason]
 */
import { randomUUID } from "node:crypto";
import { emailSchema } from "@padelloyalty/shared";
import { sql } from "drizzle-orm";
import { createDatabase } from "../db/client.js";
import { users } from "../db/schema.js";
import { loadEnv } from "../env.js";
import { LedgerError, PointsLedger } from "./ledger.js";

const [emailArg, amountArg, ...reasonParts] = process.argv.slice(2);

if (process.env.NODE_ENV === "production") {
  console.error("points:credit is a development tool and does not run with NODE_ENV=production.");
  process.exit(1);
}
const email = emailSchema.safeParse(emailArg ?? "");
const amount = Number(amountArg);
if (!email.success || !Number.isInteger(amount)) {
  console.error("Usage: points:credit <email> <amount> [reason]");
  process.exit(1);
}

const { DATABASE_URL } = loadEnv();
const { db, pool } = createDatabase(DATABASE_URL);
try {
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.email}) = ${email.data}`);
  if (!user) throw new Error(`No account with the email ${email.data}.`);
  const ledger = new PointsLedger({ db });
  const input = {
    userId: user.id,
    amount: Math.abs(amount),
    type: "adjustment" as const,
    reason: reasonParts.join(" ") || "Development credit",
    reference: "dev:points-credit",
    idempotencyKey: `dev-credit:${randomUUID()}`,
    actor: { type: "system" as const },
  };
  const result = amount >= 0 ? await ledger.credit(input) : await ledger.debit(input);
  console.log(`${email.data}: ${amount >= 0 ? "+" : ""}${amount}, balance now ${result.balance}.`);
} catch (error) {
  if (error instanceof LedgerError) console.error(`${error.code}: ${error.message}`);
  else console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
