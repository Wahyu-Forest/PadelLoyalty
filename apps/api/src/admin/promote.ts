import { emailSchema } from "@padelloyalty/shared";
import { eq, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { users } from "../db/schema.js";

export type PromoteResult =
  | { outcome: "promoted"; email: string; previousRole: string }
  | { outcome: "already_admin"; email: string }
  | { outcome: "not_found"; email: string }
  | { outcome: "not_verified"; email: string }
  | { outcome: "invalid_email"; email: string };

/**
 * Makes an existing account with a verified email an `admin` (#56). Used by
 * `pnpm --filter @padelloyalty/api admin:create <email>` to create the first
 * admin, and by tests. Never creates accounts. Takes effect on the user's
 * next request (roles are read from the database every time).
 */
export async function promoteToAdmin(db: Database, rawEmail: string): Promise<PromoteResult> {
  const parsed = emailSchema.safeParse(rawEmail);
  if (!parsed.success) return { outcome: "invalid_email", email: rawEmail };
  const email = parsed.data;
  return db.transaction(async (tx) => {
    const [user] = await tx
      .select({ id: users.id, role: users.role, emailVerifiedAt: users.emailVerifiedAt })
      .from(users)
      .where(eq(sql`lower(${users.email})`, email))
      .for("update");
    if (!user) return { outcome: "not_found", email };
    if (!user.emailVerifiedAt) return { outcome: "not_verified", email };
    if (user.role === "admin") return { outcome: "already_admin", email };
    await tx
      .update(users)
      .set({ role: "admin", updatedAt: new Date() })
      .where(eq(users.id, user.id));
    return { outcome: "promoted", email, previousRole: user.role };
  });
}

export function describePromotion(result: PromoteResult): { message: string; ok: boolean } {
  switch (result.outcome) {
    case "promoted":
      return { ok: true, message: `${result.email} is now an admin (was ${result.previousRole}).` };
    case "already_admin":
      return { ok: true, message: `${result.email} is already an admin. Nothing changed.` };
    case "not_found":
      return {
        ok: false,
        message: `No account with the email ${result.email}. Sign up in the app first, verify the email, then run this again.`,
      };
    case "not_verified":
      return {
        ok: false,
        message: `${result.email} has not verified its email yet. Open the verification link first, then run this again.`,
      };
    case "invalid_email":
      return { ok: false, message: `"${result.email}" is not a valid email address.` };
  }
}
