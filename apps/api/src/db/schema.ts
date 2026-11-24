import {
  ACCOUNT_STATUSES,
  COURT_BLOCK_REASONS,
  COURT_ENVIRONMENTS,
  DEFAULT_CURRENCY,
  USER_ROLES,
  type ClubPricing,
  type OpeningHours,
} from "@padelloyalty/shared";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
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
// Clubs, courts, pricing and court blocks (#56). See docs/api/clubs.md.
// ---------------------------------------------------------------------------

/**
 * A Soul Padel club. Opening hours and pricing are JSON documents validated
 * by the shared Zod schemas (`openingHoursSchema`, `clubPricingSchema`) before
 * they are written; both are wall-clock times in `time_zone`. Clubs are never
 * deleted: `active = false` hides them from members.
 */
export const clubs = pgTable(
  "clubs",
  {
    id: uuid().primaryKey().defaultRandom(),
    name: text().notNull(),
    address: text().notNull(),
    /** IANA time zone, e.g. `Europe/London`. */
    timeZone: text().notNull(),
    /** ISO 4217 code; every amount of this club is in its minor unit. */
    currency: text().notNull().default(DEFAULT_CURRENCY),
    openingHours: jsonb().$type<OpeningHours>().notNull(),
    /** Slot lengths, standard prices and peak bands. Null until set up (not bookable). */
    pricing: jsonb().$type<ClubPricing>(),
    active: boolean().notNull().default(true),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("clubs_name_unique").on(sql`lower(${table.name})`),
    check("clubs_currency_iso", sql`${table.currency} ~ '^[A-Z]{3}$'`),
  ],
);

export const courtEnvironment = pgEnum("court_environment", COURT_ENVIRONMENTS);

/** A court of a club. Never deleted (bookings and blocks refer to it): deactivate instead. */
export const courts = pgTable(
  "courts",
  {
    id: uuid().primaryKey().defaultRandom(),
    clubId: uuid()
      .notNull()
      .references(() => clubs.id, { onDelete: "restrict" }),
    name: text().notNull(),
    environment: courtEnvironment().notNull(),
    active: boolean().notNull().default(true),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("courts_club_name_unique").on(table.clubId, sql`lower(${table.name})`),
    // Target of the (club_id, court_id) foreign keys, so a block can't point at another club's court.
    unique("courts_club_id_id_unique").on(table.clubId, table.id),
  ],
);

export const courtBlockReason = pgEnum("court_block_reason", COURT_BLOCK_REASONS);

/**
 * A period when a court can't be booked (maintenance, events). Instants in
 * UTC; the club's time zone gives the wall-clock times. Cancelling sets
 * `cancelled_at` instead of deleting, so the record stays.
 */
export const courtBlocks = pgTable(
  "court_blocks",
  {
    id: uuid().primaryKey().defaultRandom(),
    clubId: uuid().notNull(),
    courtId: uuid().notNull(),
    startsAt: timestamp({ withTimezone: true }).notNull(),
    endsAt: timestamp({ withTimezone: true }).notNull(),
    reason: courtBlockReason().notNull(),
    note: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    createdByUserId: uuid().references(() => users.id, { onDelete: "set null" }),
    cancelledAt: timestamp({ withTimezone: true }),
    cancelledByUserId: uuid().references(() => users.id, { onDelete: "set null" }),
  },
  (table) => [
    foreignKey({
      name: "court_blocks_club_court_fk",
      columns: [table.clubId, table.courtId],
      foreignColumns: [courts.clubId, courts.id],
    }).onDelete("restrict"),
    check("court_blocks_ends_after_starts", sql`${table.endsAt} > ${table.startsAt}`),
    index("court_blocks_court_time_idx").on(table.courtId, table.startsAt),
    index("court_blocks_club_time_idx").on(table.clubId, table.startsAt),
  ],
);

export type ClubRow = typeof clubs.$inferSelect;
export type CourtRow = typeof courts.$inferSelect;
export type CourtBlockRow = typeof courtBlocks.$inferSelect;

export type UserRow = typeof users.$inferSelect;
export type GuardianConsentRequestRow = typeof guardianConsentRequests.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
