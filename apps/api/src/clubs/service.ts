import {
  WEEKDAYS,
  toLocalDateTime,
  type AdminClubSummary,
  type Club,
  type ClubPricing,
  type Court,
  type CourtBlock,
  type CourtBlockReason,
  type PublicCourtBlock,
  type CourtEnvironment,
  type OpeningHours,
} from "@padelloyalty/shared";
import { and, asc, eq, getTableColumns, gt, inArray, isNull, lt, sql, type SQL } from "drizzle-orm";
import type { Database } from "../db/client.js";
import {
  clubs,
  courtBlocks,
  courts,
  type ClubRow,
  type CourtBlockRow,
  type CourtRow,
} from "../db/schema.js";
import { ApiError } from "../http/errors.js";

/** A transaction or the database: lets #23 check blocks inside its booking transaction. */
type Executor = Pick<Database, "select">;

export interface ClubInput {
  name: string;
  address: string;
  timeZone: string;
  currency: string;
  openingHours: OpeningHours;
  active: boolean;
}

export interface CourtInput {
  name: string;
  environment: CourtEnvironment;
  active: boolean;
}

export interface NewBlocks {
  courtIds: string[];
  startsAt: Date;
  endsAt: Date;
  reason: CourtBlockReason;
  note: string | null;
}

export const notFound = () => new ApiError(404, "not_found", "Not found.");

const clubNameTaken = () =>
  new ApiError(409, "club_name_taken", "Another club already has this name.");
const courtNameTaken = () =>
  new ApiError(409, "court_name_taken", "This club already has a court with this name.");

/** Postgres unique violation on the named constraint/index (drizzle wraps the pg error in `cause`). */
function isUniqueViolation(error: unknown, constraint: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
    const pg = current as { code?: string; constraint?: string; cause?: unknown };
    if (pg.code === "23505" && pg.constraint === constraint) return true;
    current = pg.cause;
  }
  return false;
}

const byLowerName = (column: typeof clubs.name | typeof courts.name) => asc(sql`lower(${column})`);

export function toClub(row: ClubRow): Club {
  return {
    id: row.id,
    name: row.name,
    address: row.address,
    timeZone: row.timeZone,
    currency: row.currency,
    // jsonb stores object keys in its own order; answer Monday first.
    openingHours: Object.fromEntries(
      WEEKDAYS.map((day) => [day, row.openingHours[day] ?? null]),
    ) as OpeningHours,
    active: row.active,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toCourt(row: CourtRow): Court {
  return {
    id: row.id,
    clubId: row.clubId,
    name: row.name,
    environment: row.environment,
    active: row.active,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toCourtBlock(row: CourtBlockRow, timeZone: string): CourtBlock {
  return {
    id: row.id,
    clubId: row.clubId,
    courtId: row.courtId,
    reason: row.reason,
    note: row.note,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    startsLocal: toLocalDateTime(row.startsAt, timeZone),
    endsLocal: toLocalDateTime(row.endsAt, timeZone),
    createdAt: row.createdAt.toISOString(),
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
  };
}

/** Clubs, courts, pricing and court blocks (#56). Access checks are the routes' job. */
export class ClubService {
  constructor(
    private readonly db: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  // -------------------------------------------------------------------------
  // Clubs
  // -------------------------------------------------------------------------

  async listClubsForAdmin(scope: "all" | string[]): Promise<AdminClubSummary[]> {
    if (scope !== "all" && scope.length === 0) return [];
    const rows = await this.db
      .select({
        club: getTableColumns(clubs),
        courtCount: sql<number>`count(${courts.id})::int`,
        activeCourtCount: sql<number>`(count(${courts.id}) filter (where ${courts.active}))::int`,
      })
      .from(clubs)
      .leftJoin(courts, eq(courts.clubId, clubs.id))
      .where(scope === "all" ? undefined : inArray(clubs.id, scope))
      .groupBy(clubs.id)
      .orderBy(byLowerName(clubs.name), asc(clubs.id));
    return rows.map((row) => ({
      ...toClub(row.club),
      courtCount: row.courtCount,
      activeCourtCount: row.activeCourtCount,
      hasPricing: row.club.pricing !== null,
    }));
  }

  async getClub(clubId: string): Promise<ClubRow | null> {
    const [row] = await this.db.select().from(clubs).where(eq(clubs.id, clubId));
    return row ?? null;
  }

  async requireClub(clubId: string): Promise<ClubRow> {
    const club = await this.getClub(clubId);
    if (!club) throw notFound();
    return club;
  }

  async createClub(input: ClubInput): Promise<ClubRow> {
    try {
      const [row] = await this.db.insert(clubs).values(input).returning();
      return row!;
    } catch (error) {
      if (isUniqueViolation(error, "clubs_name_unique")) throw clubNameTaken();
      throw error;
    }
  }

  async updateClub(clubId: string, patch: Partial<ClubInput>): Promise<ClubRow> {
    try {
      return await this.db.transaction(async (tx) => {
        const [current] = await tx.select().from(clubs).where(eq(clubs.id, clubId)).for("update");
        if (!current) throw notFound();
        if (
          patch.currency !== undefined &&
          patch.currency !== current.currency &&
          current.pricing !== null
        ) {
          throw new ApiError(
            409,
            "currency_locked",
            `This club has prices in ${current.currency}. Remove its prices before changing the currency.`,
          );
        }
        const [row] = await tx
          .update(clubs)
          .set({ ...patch, updatedAt: this.now() })
          .where(eq(clubs.id, clubId))
          .returning();
        return row!;
      });
    } catch (error) {
      if (isUniqueViolation(error, "clubs_name_unique")) throw clubNameTaken();
      throw error;
    }
  }

  async setPricing(clubId: string, pricing: ClubPricing): Promise<ClubPricing> {
    const [row] = await this.db
      .update(clubs)
      .set({ pricing, updatedAt: this.now() })
      .where(eq(clubs.id, clubId))
      .returning({ pricing: clubs.pricing });
    if (!row?.pricing) throw notFound();
    return row.pricing;
  }

  async clearPricing(clubId: string): Promise<void> {
    const [row] = await this.db
      .update(clubs)
      .set({ pricing: null, updatedAt: this.now() })
      .where(eq(clubs.id, clubId))
      .returning({ id: clubs.id });
    if (!row) throw notFound();
  }

  // -------------------------------------------------------------------------
  // Courts
  // -------------------------------------------------------------------------

  async listCourts(clubId: string, options: { activeOnly?: boolean } = {}): Promise<CourtRow[]> {
    return this.db
      .select()
      .from(courts)
      .where(
        and(eq(courts.clubId, clubId), options.activeOnly ? eq(courts.active, true) : undefined),
      )
      .orderBy(byLowerName(courts.name), asc(courts.id));
  }

  async createCourt(clubId: string, input: CourtInput): Promise<CourtRow> {
    try {
      const [row] = await this.db
        .insert(courts)
        .values({ ...input, clubId })
        .returning();
      return row!;
    } catch (error) {
      if (isUniqueViolation(error, "courts_club_name_unique")) throw courtNameTaken();
      throw error;
    }
  }

  async updateCourt(
    clubId: string,
    courtId: string,
    patch: Partial<CourtInput>,
  ): Promise<CourtRow> {
    try {
      const [row] = await this.db
        .update(courts)
        .set({ ...patch, updatedAt: this.now() })
        .where(and(eq(courts.id, courtId), eq(courts.clubId, clubId)))
        .returning();
      if (!row) throw notFound();
      return row;
    } catch (error) {
      if (isUniqueViolation(error, "courts_club_name_unique")) throw courtNameTaken();
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Court blocks
  // -------------------------------------------------------------------------

  /** One block per court, all or nothing. Every court must belong to the club. */
  async createBlocks(clubId: string, input: NewBlocks, userId: string): Promise<CourtBlockRow[]> {
    return this.db.transaction(async (tx) => {
      const found = await tx
        .select({ id: courts.id, name: courts.name })
        .from(courts)
        .where(and(eq(courts.clubId, clubId), inArray(courts.id, input.courtIds)));
      if (found.length !== input.courtIds.length) {
        throw new ApiError(400, "validation_error", "Some fields are missing or invalid.", {
          fieldErrors: { courtIds: ["Choose courts of this club"] },
        });
      }
      const rows = await tx
        .insert(courtBlocks)
        .values(
          input.courtIds.map((courtId) => ({
            clubId,
            courtId,
            startsAt: input.startsAt,
            endsAt: input.endsAt,
            reason: input.reason,
            note: input.note,
            createdAt: this.now(),
            createdByUserId: userId,
          })),
        )
        .returning();
      const nameOf = new Map(found.map((court) => [court.id, court.name.toLowerCase()]));
      return rows.sort((a, b) =>
        (nameOf.get(a.courtId) ?? "").localeCompare(nameOf.get(b.courtId) ?? ""),
      );
    });
  }

  /** Blocks overlapping [from, to), ordered by start then court name. */
  async listBlocks(
    clubId: string,
    query: { from?: Date; to?: Date; courtId?: string; includeCancelled?: boolean },
  ): Promise<CourtBlockRow[]> {
    const from = query.from ?? this.now();
    const conditions: (SQL | undefined)[] = [
      eq(courtBlocks.clubId, clubId),
      gt(courtBlocks.endsAt, from),
      query.to ? lt(courtBlocks.startsAt, query.to) : undefined,
      query.courtId ? eq(courtBlocks.courtId, query.courtId) : undefined,
      query.includeCancelled ? undefined : isNull(courtBlocks.cancelledAt),
    ];
    const rows = await this.db
      .select({ block: courtBlocks })
      .from(courtBlocks)
      .innerJoin(courts, eq(courts.id, courtBlocks.courtId))
      .where(and(...conditions))
      .orderBy(asc(courtBlocks.startsAt), byLowerName(courts.name), asc(courtBlocks.id));
    return rows.map((row) => row.block);
  }

  /** Marks a block cancelled. Idempotent; 404 for a block of another club. */
  async cancelBlock(clubId: string, blockId: string, userId: string): Promise<void> {
    const [row] = await this.db
      .select({ cancelledAt: courtBlocks.cancelledAt })
      .from(courtBlocks)
      .where(and(eq(courtBlocks.id, blockId), eq(courtBlocks.clubId, clubId)));
    if (!row) throw notFound();
    if (row.cancelledAt) return;
    await this.db
      .update(courtBlocks)
      .set({ cancelledAt: this.now(), cancelledByUserId: userId })
      .where(and(eq(courtBlocks.id, blockId), isNull(courtBlocks.cancelledAt)));
  }

  /**
   * Non-cancelled blocks on `courtId` overlapping [startsAt, endsAt). A slot
   * is bookable only if this is empty. For booking (#23): pass the booking
   * transaction as `executor`.
   */
  async findBlockingBlocks(
    courtId: string,
    startsAt: Date,
    endsAt: Date,
    executor: Executor = this.db,
  ): Promise<CourtBlockRow[]> {
    return executor
      .select()
      .from(courtBlocks)
      .where(
        and(
          eq(courtBlocks.courtId, courtId),
          isNull(courtBlocks.cancelledAt),
          lt(courtBlocks.startsAt, endsAt),
          gt(courtBlocks.endsAt, startsAt),
        ),
      );
  }

  // -------------------------------------------------------------------------
  // Public reads
  // -------------------------------------------------------------------------

  async listActiveClubs(): Promise<ClubRow[]> {
    return this.db
      .select()
      .from(clubs)
      .where(eq(clubs.active, true))
      .orderBy(byLowerName(clubs.name), asc(clubs.id));
  }

  async getActiveClub(clubId: string): Promise<ClubRow | null> {
    const [row] = await this.db
      .select()
      .from(clubs)
      .where(and(eq(clubs.id, clubId), eq(clubs.active, true)));
    return row ?? null;
  }

  /** Non-cancelled blocks on the club's active courts overlapping [from, to). */
  async listPublicBlocks(clubId: string, from: Date, to: Date): Promise<PublicCourtBlock[]> {
    const rows = await this.db
      .select({
        courtId: courtBlocks.courtId,
        startsAt: courtBlocks.startsAt,
        endsAt: courtBlocks.endsAt,
      })
      .from(courtBlocks)
      .innerJoin(courts, eq(courts.id, courtBlocks.courtId))
      .where(
        and(
          eq(courtBlocks.clubId, clubId),
          eq(courts.active, true),
          isNull(courtBlocks.cancelledAt),
          lt(courtBlocks.startsAt, to),
          gt(courtBlocks.endsAt, from),
        ),
      )
      .orderBy(asc(courtBlocks.startsAt), asc(courtBlocks.courtId));
    return rows.map((row) => ({
      courtId: row.courtId,
      startsAt: row.startsAt.toISOString(),
      endsAt: row.endsAt.toISOString(),
    }));
  }
}
