import { z } from "zod";

/**
 * Points (Soul points) contract, issue #6. Human-readable version:
 * docs/api/points.md. UI copy uses `POINTS_NAME` (branding.ts); identifiers
 * here stay neutral ("points").
 *
 * Points are an append-only ledger: every earn, redeem, staff adjustment and
 * expiry is one immutable entry with a signed amount, and a member's balance
 * is the sum of their entries. Nothing ever edits or deletes an entry; a
 * mistake is corrected with a new `adjustment` entry.
 */

// ---------------------------------------------------------------------------
// Ledger model
// ---------------------------------------------------------------------------

/**
 * Kind of ledger entry, and the sign its amount must have:
 *
 * - `earn` (> 0): points for a check-in (#7, #8), referral, ...
 * - `redeem` (< 0): points spent on a reward (#15).
 * - `adjustment` (either sign, never 0): a staff correction (#34).
 * - `expiry` (< 0): points that expired (#10).
 */
export const POINTS_ENTRY_TYPES = ["earn", "redeem", "adjustment", "expiry"] as const;
export const pointsEntryTypeSchema = z.enum(POINTS_ENTRY_TYPES);
export type PointsEntryType = z.infer<typeof pointsEntryTypeSchema>;

/** Entry types that add points, and those that take them away. Adjustments can do either. */
export const CREDIT_ENTRY_TYPES = ["earn", "adjustment"] as const satisfies PointsEntryType[];
export const DEBIT_ENTRY_TYPES = [
  "redeem",
  "adjustment",
  "expiry",
] as const satisfies PointsEntryType[];
export type CreditEntryType = (typeof CREDIT_ENTRY_TYPES)[number];
export type DebitEntryType = (typeof DEBIT_ENTRY_TYPES)[number];

/**
 * Who or what created an entry.
 *
 * - `system`: automatic (check-in earn, expiry job). No user id.
 * - `member`: the member themselves (e.g. redeeming a reward). User id required.
 * - `staff`: a receptionist, club manager or admin (e.g. an adjustment). User id required.
 */
export const POINTS_ACTOR_TYPES = ["system", "member", "staff"] as const;
export const pointsActorTypeSchema = z.enum(POINTS_ACTOR_TYPES);
export type PointsActorType = z.infer<typeof pointsActorTypeSchema>;

/** Largest amount one entry may add or take away. Guards against typos and overflow. */
export const POINTS_ENTRY_MAX_AMOUNT = 1_000_000;

/**
 * The size of a credit or debit: a whole number from 1 to
 * `POINTS_ENTRY_MAX_AMOUNT`. The ledger stores it signed (debits negative).
 */
export const pointsAmountSchema = z
  .number({ error: "Enter a number of points" })
  .int("Points must be a whole number")
  .min(1, "Points must be at least 1")
  .max(POINTS_ENTRY_MAX_AMOUNT, `Points can be at most ${POINTS_ENTRY_MAX_AMOUNT}`);

export const IDEMPOTENCY_KEY_MAX_LENGTH = 200;

/**
 * Identifies the source event of an entry, so it can be recorded only once
 * ("no double counting"). Unique across the whole ledger. Build it from the
 * event, never from random values, e.g. `checkin:<bookingId>:<userId>` (#7),
 * `redemption:<redemptionId>` (#15), `adjustment:<requestId>` (#34),
 * `expiry:<userId>:<period>` (#10). Printable ASCII, no spaces.
 */
export const idempotencyKeySchema = z
  .string()
  .min(1, "Idempotency key is required")
  .max(IDEMPOTENCY_KEY_MAX_LENGTH, "Idempotency key is too long")
  .regex(/^[\x21-\x7e]+$/, "Idempotency key must be printable ASCII without spaces");

export const POINTS_REASON_MAX_LENGTH = 500;

/** Human-readable reason, shown in points history (#9) and the audit trail (#34). */
export const pointsReasonSchema = z
  .string()
  .trim()
  .min(1, "Give a reason")
  .max(POINTS_REASON_MAX_LENGTH, "Reason is too long");

// ---------------------------------------------------------------------------
// Ledger service errors (server side; see LedgerError in apps/api)
// ---------------------------------------------------------------------------

/**
 * Why the ledger service refused a write. Not HTTP error codes yet: no public
 * endpoint writes to the ledger in #6. Features that do (#15 redeem, #34
 * adjustments) map them to responses.
 *
 * - `invalid_entry`: amount, key, reason, type or actor failed validation.
 * - `member_not_found`: no user with that id.
 * - `insufficient_points`: a debit larger than the current balance.
 * - `idempotency_key_reused`: the key was already used for a different entry
 *   (other member, amount, type or actor). A replay of the same entry is not
 *   an error: it returns the original entry.
 */
export const POINTS_LEDGER_ERROR_CODES = [
  "invalid_entry",
  "member_not_found",
  "insufficient_points",
  "idempotency_key_reused",
] as const;
export const pointsLedgerErrorCodeSchema = z.enum(POINTS_LEDGER_ERROR_CODES);
export type PointsLedgerErrorCode = z.infer<typeof pointsLedgerErrorCodeSchema>;

// ---------------------------------------------------------------------------
// GET /points/balance
// ---------------------------------------------------------------------------

/**
 * 200 from GET /points/balance: the logged-in member's balance, the sum of
 * their ledger entries. Never negative in practice (debits cannot overdraw),
 * but clients display whatever the server says.
 */
export const pointsBalanceResponseSchema = z.object({
  balance: z.number().int(),
  /** When the balance was read. */
  asOf: z.iso.datetime(),
});
export type PointsBalanceResponse = z.infer<typeof pointsBalanceResponseSchema>;
