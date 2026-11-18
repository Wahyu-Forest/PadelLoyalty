import { ACCOUNT_STATUSES, USER_ROLES } from "@padelloyalty/shared";
import { sql } from "drizzle-orm";
import { index, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/**
 * Placeholder table created by the first migration, proving the migration
 * pipeline works end to end. Key/value metadata about the deployment
 * (not product data).
 */
export const appMeta = pgTable("app_meta", {
  key: text().primaryKey(),
  value: text().notNull(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Accounts and auth (#1). See docs/ARCHITECTURE.md#authentication.
// ---------------------------------------------------------------------------

export const userRole = pgEnum("user_role", USER_ROLES);

/**
 * Account lifecycle. New states (e.g. `pending_consent` for under-18s, #3)
 * are added with `ALTER TYPE account_status ADD VALUE`.
 */
export const accountStatus = pgEnum("account_status", ACCOUNT_STATUSES);

export const users = pgTable(
  "users",
  {
    id: uuid().primaryKey().defaultRandom(),
    /** Normalised (trimmed, lower-cased) by `emailSchema` before it gets here. */
    email: text().notNull(),
    /**
     * argon2id PHC string. Nullable so an account created through Apple or
     * Google sign-in later can exist without a password.
     */
    passwordHash: text(),
    role: userRole().notNull().default("member"),
    status: accountStatus().notNull().default("pending_verification"),
    emailVerifiedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("users_email_unique").on(sql`lower(${table.email})`)],
);

/**
 * One row per logged-in device. Holds SHA-256 hashes of the current access
 * and refresh tokens (never the tokens themselves). Refreshing rotates both;
 * the replaced refresh hashes go to `rotatedRefreshTokens`.
 */
export const sessions = pgTable(
  "sessions",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accessTokenHash: text().notNull(),
    accessTokenExpiresAt: timestamp({ withTimezone: true }).notNull(),
    refreshTokenHash: text().notNull(),
    refreshTokenExpiresAt: timestamp({ withTimezone: true }).notNull(),
    userAgent: text(),
    createdAt: timestamp({ withTimezone: true }).notNull(),
    lastRefreshedAt: timestamp({ withTimezone: true }),
    revokedAt: timestamp({ withTimezone: true }),
  },
  (table) => [
    uniqueIndex("sessions_access_token_hash_unique").on(table.accessTokenHash),
    uniqueIndex("sessions_refresh_token_hash_unique").on(table.refreshTokenHash),
    index("sessions_user_id_idx").on(table.userId),
  ],
);

/**
 * Every refresh token a session has rotated away from (hashed). Presenting
 * one again means it was copied, so the session is revoked (reuse detection).
 * Rows go when their session is deleted.
 */
export const rotatedRefreshTokens = pgTable(
  "rotated_refresh_tokens",
  {
    tokenHash: text().primaryKey(),
    sessionId: uuid()
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    rotatedAt: timestamp({ withTimezone: true }).notNull(),
  },
  (table) => [index("rotated_refresh_tokens_session_id_idx").on(table.sessionId)],
);

export const emailTokenPurpose = pgEnum("email_token_purpose", ["verify_email", "password_reset"]);

/** Single-use, expiring tokens sent in email links. Stored as SHA-256 hashes. */
export const emailTokens = pgTable(
  "email_tokens",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    purpose: emailTokenPurpose().notNull(),
    tokenHash: text().notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    /** Set when the token is used, or when a newer token of the same purpose replaces it. */
    consumedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("email_tokens_token_hash_unique").on(table.tokenHash),
    index("email_tokens_user_purpose_idx").on(table.userId, table.purpose),
  ],
);

export type UserRow = typeof users.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
