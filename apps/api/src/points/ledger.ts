import {
  CREDIT_ENTRY_TYPES,
  DEBIT_ENTRY_TYPES,
  idempotencyKeySchema,
  pointsAmountSchema,
  pointsReasonSchema,
  type CreditEntryType,
  type DebitEntryType,
  type PointsActorType,
  type PointsEntryType,
  type PointsLedgerErrorCode,
} from "@padelloyalty/shared";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client.js";
import { pointsLedgerEntries, users, type PointsLedgerEntryRow } from "../db/schema.js";

/**
 * The points ledger service (#6). The only code that writes points: earn on
 * check-in (#7), redeem (#15), staff adjustments (#34) and expiry (#10) call
 * it. Contract: docs/api/points.md.
 *
 * - Entries are append-only (the database rejects UPDATE and DELETE).
 * - The balance is always SUM(amount); nothing stores it.
 * - An idempotency key identifies the source event, so it is recorded once.
 * - Writes for one member are serialised, so debits cannot overdraw.
 */

/** Who or what makes the change: the system, or a member / staff user. */
export type PointsActor =
  { type: "system" } | { type: Exclude<PointsActorType, "system">; userId: string };

interface EntryInput<T extends PointsEntryType> {
  /** The member whose points change. */
  userId: string;
  /** Positive. Debits are stored negative. */
  amount: number;
  type: T;
  reason: string;
  /** Optional pointer to the source record, e.g. `booking:<id>`. */
  reference?: string | null;
  /** Derived from the source event, e.g. `checkin:<bookingId>:<userId>`. */
  idempotencyKey: string;
  actor: PointsActor;
}

export type CreditInput = EntryInput<CreditEntryType>;
export type DebitInput = EntryInput<DebitEntryType>;

export interface LedgerEntry {
  id: string;
  userId: string;
  type: PointsEntryType;
  /** Signed: positive for credits, negative for debits. */
  amount: number;
  reason: string;
  reference: string | null;
  idempotencyKey: string;
  actorType: PointsActorType;
  actorUserId: string | null;
  createdAt: Date;
}

export interface LedgerWriteResult {
  entry: LedgerEntry;
  /** False when the idempotency key had already recorded this same entry (a replay). */
  created: boolean;
  /** The member's balance after the call. */
  balance: number;
}

export class LedgerError extends Error {
  constructor(
    readonly code: PointsLedgerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LedgerError";
  }
}

/** A Drizzle database or an open transaction on one. */
export type Executor = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * First key of the two-key advisory lock that serialises one member's ledger
 * writes (the second key is derived from the user id). Arbitrary constant,
 * reserved for the points ledger.
 */
const LEDGER_LOCK_CLASS = 60_601;

const uuidSchema = z.uuid();
const referenceSchema = z.string().trim().min(1).max(500).nullable();

export class PointsLedger {
  private readonly db: Database;
  private readonly now: () => Date;

  constructor(options: { db: Database; now?: () => Date }) {
    this.db = options.db;
    this.now = options.now ?? (() => new Date());
  }

  /** Adds points (`earn`, or a positive `adjustment`). */
  async credit(input: CreditInput, tx?: Executor): Promise<LedgerWriteResult> {
    if (!(CREDIT_ENTRY_TYPES as readonly string[]).includes(input.type)) {
      throw invalid(`A credit cannot be of type "${String(input.type)}".`);
    }
    return this.write(input, 1, tx);
  }

  /**
   * Takes points away (`redeem`, `expiry`, or a negative `adjustment`).
   * Throws `insufficient_points` if the member's balance is smaller than the
   * amount; nothing is written then.
   */
  async debit(input: DebitInput, tx?: Executor): Promise<LedgerWriteResult> {
    if (!(DEBIT_ENTRY_TYPES as readonly string[]).includes(input.type)) {
      throw invalid(`A debit cannot be of type "${String(input.type)}".`);
    }
    return this.write(input, -1, tx);
  }

  /** The member's current balance: the sum of their entries (0 if none). */
  async balance(userId: string, tx?: Executor): Promise<number> {
    if (!uuidSchema.safeParse(userId).success) return 0;
    return sumFor(tx ?? this.db, userId);
  }

  private async write(
    input: EntryInput<PointsEntryType>,
    sign: 1 | -1,
    tx: Executor | undefined,
  ): Promise<LedgerWriteResult> {
    const entry = validate(input, sign);
    const run = async (t: Executor) => {
      // Serialise this member's writes until the transaction ends. Statements
      // after the lock see everything committed before it (READ COMMITTED).
      await t.execute(
        sql`select pg_advisory_xact_lock(${LEDGER_LOCK_CLASS}, hashtext(${entry.userId}))`,
      );

      const existing = await findByKey(t, entry.idempotencyKey);
      if (existing) return replay(t, existing, entry);

      const [member] = await t
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, entry.userId));
      if (!member) throw new LedgerError("member_not_found", "No member with that id.");

      const before = await sumFor(t, entry.userId);
      if (before + entry.amount < 0) {
        throw new LedgerError(
          "insufficient_points",
          `Not enough points: the balance is ${before}, the debit is ${-entry.amount}.`,
        );
      }

      const [inserted] = await t
        .insert(pointsLedgerEntries)
        .values({ ...entry, createdAt: this.now() })
        .onConflictDoNothing({ target: pointsLedgerEntries.idempotencyKey })
        .returning();
      if (!inserted) {
        // Same key recorded concurrently for another member (whose lock we
        // don't hold); the unique index made us wait for it to commit.
        const raced = await findByKey(t, entry.idempotencyKey);
        if (!raced) throw new Error("idempotency conflict without a row");
        return replay(t, raced, entry);
      }
      return { entry: toEntry(inserted), created: true, balance: before + entry.amount };
    };
    if (tx) return run(tx);
    return this.db.transaction(run);
  }
}

type NewEntry = Omit<typeof pointsLedgerEntries.$inferInsert, "id" | "createdAt"> & {
  userId: string;
  amount: number;
  idempotencyKey: string;
};

function invalid(message: string): LedgerError {
  return new LedgerError("invalid_entry", message);
}

function validate(input: EntryInput<PointsEntryType>, sign: 1 | -1): NewEntry {
  const fail = invalid;
  if (!uuidSchema.safeParse(input.userId).success) {
    throw new LedgerError("member_not_found", "No member with that id.");
  }
  const amount = pointsAmountSchema.safeParse(input.amount);
  if (!amount.success) throw fail(amount.error.issues[0]?.message ?? "Invalid amount.");
  const key = idempotencyKeySchema.safeParse(input.idempotencyKey);
  if (!key.success) throw fail(key.error.issues[0]?.message ?? "Invalid idempotency key.");
  const reason = pointsReasonSchema.safeParse(input.reason);
  if (!reason.success) throw fail(reason.error.issues[0]?.message ?? "Invalid reason.");
  const reference = referenceSchema.safeParse(input.reference ?? null);
  if (!reference.success) throw fail("Reference must be 1 to 500 characters.");

  const actor = input.actor as { type?: unknown; userId?: unknown } | undefined;
  let actorUserId: string | null;
  let actorType: PointsActorType;
  if (actor?.type === "system") {
    actorType = "system";
    actorUserId = null;
  } else if (actor?.type === "member" || actor?.type === "staff") {
    if (typeof actor.userId !== "string" || !uuidSchema.safeParse(actor.userId).success) {
      throw fail("A member or staff actor needs a valid user id.");
    }
    actorType = actor.type;
    actorUserId = actor.userId;
  } else {
    throw fail("Unknown actor.");
  }

  return {
    userId: input.userId,
    entryType: input.type,
    amount: sign * amount.data,
    reason: reason.data,
    reference: reference.data,
    idempotencyKey: key.data,
    actorType,
    actorUserId,
  };
}

async function findByKey(t: Executor, key: string): Promise<PointsLedgerEntryRow | undefined> {
  const [row] = await t
    .select()
    .from(pointsLedgerEntries)
    .where(eq(pointsLedgerEntries.idempotencyKey, key));
  return row;
}

/** The key was already used: fine if it was for this same entry, an error otherwise. */
async function replay(
  t: Executor,
  existing: PointsLedgerEntryRow,
  wanted: NewEntry,
): Promise<LedgerWriteResult> {
  const same =
    existing.userId === wanted.userId &&
    existing.entryType === wanted.entryType &&
    existing.amount === wanted.amount &&
    existing.reference === (wanted.reference ?? null) &&
    existing.actorType === wanted.actorType &&
    existing.actorUserId === (wanted.actorUserId ?? null);
  if (!same) {
    throw new LedgerError(
      "idempotency_key_reused",
      "This idempotency key was already used for a different points entry.",
    );
  }
  return { entry: toEntry(existing), created: false, balance: await sumFor(t, existing.userId) };
}

async function sumFor(t: Executor, userId: string): Promise<number> {
  const [row] = await t
    .select({ total: sql<string>`coalesce(sum(${pointsLedgerEntries.amount}), 0)` })
    .from(pointsLedgerEntries)
    .where(eq(pointsLedgerEntries.userId, userId));
  // SUM of integers is a bigint, returned as a string by node-postgres.
  return Number(row?.total ?? 0);
}

function toEntry(row: PointsLedgerEntryRow): LedgerEntry {
  return {
    id: row.id,
    userId: row.userId,
    type: row.entryType,
    amount: row.amount,
    reason: row.reason,
    reference: row.reference,
    idempotencyKey: row.idempotencyKey,
    actorType: row.actorType,
    actorUserId: row.actorUserId,
    createdAt: row.createdAt,
  };
}
