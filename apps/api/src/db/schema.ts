import {
  ACCOUNT_STATUSES,
  POINTS_ACTOR_TYPES,
  POINTS_ENTRY_MAX_AMOUNT,
  POINTS_ENTRY_TYPES,
  USER_ROLES,
} from "@padelloyalty/shared";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

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
    /**
     * `YYYY-MM-DD` (#3). Null only for accounts created before date of birth
     * was captured; those are treated as not needing guardian consent.
     */
    dateOfBirth: date({ mode: "string" }),
    /** The parent or guardian currently nominated for consent (under-18s only, #3). */
    guardianEmail: text(),
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

// ---------------------------------------------------------------------------
// Guardian consent (#3). See docs/api/consent.md.
// ---------------------------------------------------------------------------

export const consentRequestStatus = pgEnum("consent_request_status", [
  "pending",
  "confirmed",
  "declined",
  /** Replaced by a newer request (resend or guardian change) before a decision. */
  "superseded",
]);

/** How consent was collected. Only `email_link` today. */
export const consentMethod = pgEnum("consent_method", ["email_link"]);

/**
 * One row per consent email sent to a guardian: the audit record of who was
 * asked, when, and what they decided, from where. Never deleted by the flow;
 * the foreign key restricts deleting a member who has consent records.
 */
export const guardianConsentRequests = pgTable(
  "guardian_consent_requests",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    guardianEmail: text().notNull(),
    memberDateOfBirth: date({ mode: "string" }).notNull(),
    method: consentMethod().notNull().default("email_link"),
    status: consentRequestStatus().notNull().default("pending"),
    /** SHA-256 of the link token; the token itself is never stored. */
    tokenHash: text().notNull(),
    requestedAt: timestamp({ withTimezone: true }).notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    decidedAt: timestamp({ withTimezone: true }),
    decidedIp: text(),
    decidedUserAgent: text(),
    /** The guardian stated they are the member's parent or legal guardian (required to confirm). */
    guardianAttested: boolean().notNull().default(false),
    supersededAt: timestamp({ withTimezone: true }),
  },
  (table) => [
    uniqueIndex("guardian_consent_requests_token_hash_unique").on(table.tokenHash),
    // At most one live request per member, even if two sends race.
    uniqueIndex("guardian_consent_requests_one_pending")
      .on(table.userId)
      .where(sql`${table.status} = 'pending'`),
    index("guardian_consent_requests_user_id_idx").on(table.userId, table.requestedAt),
  ],
);

// ---------------------------------------------------------------------------
// Points ledger (#6). See docs/api/points.md.
// ---------------------------------------------------------------------------

export const pointsEntryType = pgEnum("points_entry_type", POINTS_ENTRY_TYPES);
export const pointsActorType = pgEnum("points_actor_type", POINTS_ACTOR_TYPES);

/**
 * Append-only points ledger: one row per earn, redeem, adjustment or expiry.
 * A member's balance is SUM(amount) over their rows. Rows are never updated
 * or deleted: the migration adds a trigger that rejects UPDATE and DELETE.
 * Write only through `PointsLedger` (apps/api/src/points/ledger.ts).
 */
export const pointsLedgerEntries = pgTable(
  "points_ledger_entries",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    entryType: pointsEntryType().notNull(),
    /** Signed: earn > 0; redeem and expiry < 0; adjustment either sign; never 0. */
    amount: integer().notNull(),
    reason: text().notNull(),
    /** Optional pointer to the source record, e.g. `booking:<id>`. */
    reference: text(),
    /** Identifies the source event; unique so it can be recorded only once. */
    idempotencyKey: text().notNull(),
    actorType: pointsActorType().notNull(),
    /** Null for `system`; the member or staff user otherwise. */
    actorUserId: uuid().references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("points_ledger_entries_idempotency_key_unique").on(table.idempotencyKey),
    // Balance (SUM over a member's rows) and history (#9, newest first).
    index("points_ledger_entries_user_idx").on(table.userId, table.createdAt),
    check(
      "points_ledger_entries_amount_sign",
      sql`${table.amount} <> 0
        and abs(${table.amount}) <= ${sql.raw(String(POINTS_ENTRY_MAX_AMOUNT))}
        and (
          (${table.entryType} = 'earn' and ${table.amount} > 0)
          or (${table.entryType} in ('redeem', 'expiry') and ${table.amount} < 0)
          or ${table.entryType} = 'adjustment'
        )`,
    ),
    check(
      "points_ledger_entries_actor",
      sql`(${table.actorType} = 'system') = (${table.actorUserId} is null)`,
    ),
    check(
      "points_ledger_entries_text_lengths",
      sql`char_length(${table.reason}) between 1 and 500
        and char_length(${table.idempotencyKey}) between 1 and 200`,
    ),
  ],
);

export type PointsLedgerEntryRow = typeof pointsLedgerEntries.$inferSelect;
export type UserRow = typeof users.$inferSelect;
export type GuardianConsentRequestRow = typeof guardianConsentRequests.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
