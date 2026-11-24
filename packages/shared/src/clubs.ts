import { z } from "zod";
import { STAFF_ROLES, type UserRole } from "./auth.js";
import { DEFAULT_CURRENCY, isValidCurrency } from "./money.js";
import {
  WEEKDAYS,
  WEEKDAY_LABELS,
  canonicalTimeZoneCase,
  fromLocalDateTime,
  isValidLocalDateTime,
  isValidTimeZone,
  minutesOfDay,
  type TimeOfDay,
  type Weekday,
} from "./zoned-time.js";

/**
 * Club and court setup API contract (issue #56): clubs, opening hours, courts,
 * slot lengths, prices (standard plus peak bands) and court blocks.
 * Human-readable version: docs/api/clubs.md.
 *
 * All times of day and block times are wall-clock times in the club's IANA
 * time zone. Money is integer minor units in the club's currency.
 */

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

/** Any staff role may open the back office (`/admin`). Members may not. */
export function canAccessBackOffice(role: UserRole): boolean {
  return STAFF_ROLES.includes(role);
}

/**
 * Who may create clubs and change club setup. Only `admin` today. Club
 * managers will manage their own club once club assignment exists (#39); the
 * API's `ClubAccessPolicy` is the place that changes.
 */
export function canSetUpClubs(role: UserRole): boolean {
  return role === "admin";
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const CLUB_NAME_MAX_LENGTH = 80;
export const CLUB_ADDRESS_MAX_LENGTH = 300;
export const COURT_NAME_MAX_LENGTH = 40;
export const PRICE_BAND_LABEL_MAX_LENGTH = 40;
export const COURT_BLOCK_NOTE_MAX_LENGTH = 200;
/** Opening hours, band times and slot lengths are on a quarter-hour grid. */
export const TIME_STEP_MINUTES = 15;
export const SLOT_LENGTH_MIN_MINUTES = 30;
export const SLOT_LENGTH_MAX_MINUTES = 240;
export const MAX_SLOT_LENGTHS = 4;
export const MAX_PRICE_BANDS = 20;
/** Upper bound for one slot's price, in minor units (100,000.00 in a 2-digit currency). */
export const MAX_PRICE_MINOR = 10_000_000;
export const MAX_COURTS_PER_BLOCK_REQUEST = 50;
/** Longest range the public blocks endpoint answers for. */
export const PUBLIC_BLOCKS_MAX_RANGE_DAYS = 62;

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

export const weekdaySchema = z.enum(WEEKDAYS);

const trimmedText = (label: string, max: number) =>
  z
    .string({ error: `Enter ${label}` })
    .trim()
    .min(1, { error: `Enter ${label}` })
    .max(max, { error: `Keep ${label} to ${max} characters or fewer` });

/** `HH:MM` on the quarter-hour grid; `24:00` means end of day. */
export const timeOfDaySchema = z
  .string({ error: "Enter a time as HH:MM" })
  .refine((value) => minutesOfDay(value) !== null, { error: "Enter a time as HH:MM (24-hour)" })
  .refine((value) => (minutesOfDay(value) ?? 0) % TIME_STEP_MINUTES === 0, {
    error: "Use quarter hours (:00, :15, :30 or :45)",
  });

export const timeZoneSchema = z
  .string({ error: "Choose a time zone" })
  .trim()
  .transform(canonicalTimeZoneCase)
  .refine(isValidTimeZone, { error: "Choose an IANA time zone such as Europe/London" });

export const currencySchema = z
  .string({ error: "Enter a currency code" })
  .trim()
  .toUpperCase()
  .refine(isValidCurrency, { error: "Use a three-letter currency code such as GBP" });

// ---------------------------------------------------------------------------
// Opening hours
// ---------------------------------------------------------------------------

/** One day's opening hours. `opens` before `closes`; `closes` may be `24:00`. */
export const dayHoursSchema = z.object({ opens: timeOfDaySchema, closes: timeOfDaySchema });
export type DayHours = z.infer<typeof dayHoursSchema>;

/**
 * Opening hours per weekday, in the club's time zone. Every day must be
 * present; `null` means closed. One opening period per day; opening past
 * midnight is not supported (close at `24:00` instead).
 */
export const openingHoursSchema = z
  .object(
    Object.fromEntries(WEEKDAYS.map((day) => [day, dayHoursSchema.nullable()])) as Record<
      Weekday,
      z.ZodNullable<typeof dayHoursSchema>
    >,
    { error: "Give opening hours for every day (null for closed)" },
  )
  .superRefine((hours, ctx) => {
    for (const day of WEEKDAYS) {
      const value = hours[day];
      if (!value) continue;
      const opens = minutesOfDay(value.opens);
      const closes = minutesOfDay(value.closes);
      if (opens === null || closes === null) continue;
      if (opens >= closes) {
        ctx.addIssue({
          code: "custom",
          path: [day],
          message: `${WEEKDAY_LABELS[day]}: closing time must be after opening time`,
        });
      }
    }
  });
export type OpeningHours = z.infer<typeof openingHoursSchema>;

// ---------------------------------------------------------------------------
// Clubs
// ---------------------------------------------------------------------------

const clubFields = {
  name: trimmedText("the club name", CLUB_NAME_MAX_LENGTH),
  address: trimmedText("the address", CLUB_ADDRESS_MAX_LENGTH),
  timeZone: timeZoneSchema,
  currency: currencySchema,
  openingHours: openingHoursSchema,
  /** Inactive clubs are hidden from members and can't be booked. */
  active: z.boolean({ error: "active must be true or false" }),
};

/** POST /admin/clubs. `currency` defaults to GBP, `active` to true. */
export const createClubRequestSchema = z.object({
  ...clubFields,
  currency: clubFields.currency.default(DEFAULT_CURRENCY),
  active: clubFields.active.default(true),
});
export type CreateClubRequest = z.input<typeof createClubRequestSchema>;

/** PATCH /admin/clubs/:clubId. Every field optional; `openingHours` replaces all seven days. */
export const updateClubRequestSchema = z.object(clubFields).partial();
export type UpdateClubRequest = z.input<typeof updateClubRequestSchema>;

export const clubSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  address: z.string(),
  timeZone: z.string(),
  currency: z.string(),
  openingHours: openingHoursSchema,
  active: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Club = z.infer<typeof clubSchema>;

// ---------------------------------------------------------------------------
// Courts
// ---------------------------------------------------------------------------

export const COURT_ENVIRONMENTS = ["indoor", "outdoor"] as const;
export const courtEnvironmentSchema = z.enum(COURT_ENVIRONMENTS, {
  error: "Choose indoor or outdoor",
});
export type CourtEnvironment = z.infer<typeof courtEnvironmentSchema>;

const courtFields = {
  /** Unique within the club, ignoring case. */
  name: trimmedText("the court name", COURT_NAME_MAX_LENGTH),
  environment: courtEnvironmentSchema,
  /** Inactive courts keep their history (blocks, later bookings) but are hidden from members. */
  active: z.boolean({ error: "active must be true or false" }),
};

/** POST /admin/clubs/:clubId/courts. `active` defaults to true. */
export const createCourtRequestSchema = z.object({
  ...courtFields,
  active: courtFields.active.default(true),
});
export type CreateCourtRequest = z.input<typeof createCourtRequestSchema>;

/** PATCH /admin/clubs/:clubId/courts/:courtId. `{ "active": false }` deactivates. */
export const updateCourtRequestSchema = z.object(courtFields).partial();
export type UpdateCourtRequest = z.input<typeof updateCourtRequestSchema>;

export const courtSchema = z.object({
  id: z.uuid(),
  clubId: z.uuid(),
  name: z.string(),
  environment: courtEnvironmentSchema,
  active: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Court = z.infer<typeof courtSchema>;

// ---------------------------------------------------------------------------
// Slot lengths and prices
// ---------------------------------------------------------------------------

export const slotLengthSchema = z
  .int({ error: "Slot length must be a whole number of minutes" })
  .min(SLOT_LENGTH_MIN_MINUTES, {
    error: `Slots must be at least ${SLOT_LENGTH_MIN_MINUTES} minutes`,
  })
  .max(SLOT_LENGTH_MAX_MINUTES, {
    error: `Slots can be at most ${SLOT_LENGTH_MAX_MINUTES} minutes`,
  })
  .refine((minutes) => minutes % TIME_STEP_MINUTES === 0, {
    error: `Slot lengths must be a multiple of ${TIME_STEP_MINUTES} minutes`,
  });

/** The price of one slot of `minutes`, in minor units of the club's currency. */
export const slotPriceSchema = z.object({
  minutes: slotLengthSchema,
  amountMinor: z
    .int({ error: "Prices are whole numbers of minor units (e.g. pence)" })
    .min(0, { error: "Prices can't be negative" })
    .max(MAX_PRICE_MINOR, { error: "That price is too high" }),
});
export type SlotPrice = z.infer<typeof slotPriceSchema>;

/**
 * A peak (or other special) price band: on `days`, slots that **start** at or
 * after `starts` and before `ends` cost `prices`. Bands of one club must not
 * overlap. Times outside every band use the club's standard prices.
 */
export const priceBandSchema = z.object({
  label: trimmedText("a band name (e.g. Peak)", PRICE_BAND_LABEL_MAX_LENGTH),
  days: z
    .array(weekdaySchema, { error: "Choose the days the band applies to" })
    .min(1, { error: "Choose at least one day for each band" }),
  starts: timeOfDaySchema,
  ends: timeOfDaySchema,
  prices: z.array(slotPriceSchema),
});
export type PriceBand = z.infer<typeof priceBandSchema>;

const byMinutes = (a: SlotPrice, b: SlotPrice) => a.minutes - b.minutes;

/**
 * PUT /admin/clubs/:clubId/pricing, and `pricing` in responses.
 *
 * - `slotLengthsMinutes`: the slot lengths members can book (e.g. 60 and 90).
 * - `standardPrices`: one price per slot length; the off-peak price, used
 *   whenever no band applies (so every opening hour has a price).
 * - `bands`: optional peak bands with their own price per slot length.
 *
 * The price of a slot is decided by its **start** time: see `priceForSlot`.
 * Lists are returned sorted (slot lengths ascending, days Monday first).
 */
export const clubPricingSchema = z
  .object({
    slotLengthsMinutes: z
      .array(slotLengthSchema, { error: "Choose at least one slot length" })
      .min(1, { error: "Choose at least one slot length" })
      .max(MAX_SLOT_LENGTHS, { error: `Offer at most ${MAX_SLOT_LENGTHS} slot lengths` }),
    standardPrices: z.array(slotPriceSchema, { error: "Give a standard price per slot length" }),
    bands: z
      .array(priceBandSchema)
      .max(MAX_PRICE_BANDS, { error: `Use at most ${MAX_PRICE_BANDS} price bands` })
      .default([]),
  })
  .superRefine((pricing, ctx) => {
    const lengths = pricing.slotLengthsMinutes;
    if (new Set(lengths).size !== lengths.length) {
      ctx.addIssue({
        code: "custom",
        path: ["slotLengthsMinutes"],
        message: "Each slot length can only be listed once",
      });
      return;
    }
    const expected = [...lengths].sort((a, b) => a - b).join(",");
    const coversLengths = (prices: SlotPrice[]) =>
      prices
        .map((p) => p.minutes)
        .sort((a, b) => a - b)
        .join(",") === expected;

    if (!coversLengths(pricing.standardPrices)) {
      ctx.addIssue({
        code: "custom",
        path: ["standardPrices"],
        message: "Give exactly one standard price for each slot length",
      });
    }

    const ranges: { band: number; day: Weekday; starts: number; ends: number }[] = [];
    pricing.bands.forEach((band, index) => {
      const name = `Band "${band.label}"`;
      if (new Set(band.days).size !== band.days.length) {
        ctx.addIssue({
          code: "custom",
          path: ["bands", index, "days"],
          message: `${name}: each day can only be listed once`,
        });
      }
      if (!coversLengths(band.prices)) {
        ctx.addIssue({
          code: "custom",
          path: ["bands", index, "prices"],
          message: `${name}: give exactly one price for each slot length`,
        });
      }
      const starts = minutesOfDay(band.starts);
      const ends = minutesOfDay(band.ends);
      if (starts === null || ends === null) return;
      if (starts >= ends) {
        ctx.addIssue({
          code: "custom",
          path: ["bands", index, "ends"],
          message: `${name}: end time must be after start time`,
        });
        return;
      }
      for (const day of new Set(band.days)) {
        for (const other of ranges) {
          if (other.day === day && starts < other.ends && other.starts < ends) {
            const otherName = pricing.bands[other.band]!.label;
            ctx.addIssue({
              code: "custom",
              path: ["bands", index],
              message: `${name} overlaps band "${otherName}" on ${WEEKDAY_LABELS[day]}`,
            });
          }
        }
        ranges.push({ band: index, day, starts, ends });
      }
    });
  })
  .transform((pricing) => ({
    slotLengthsMinutes: [...pricing.slotLengthsMinutes].sort((a, b) => a - b),
    standardPrices: [...pricing.standardPrices].sort(byMinutes),
    bands: pricing.bands.map((band) => ({
      ...band,
      days: WEEKDAYS.filter((day) => band.days.includes(day)),
      prices: [...band.prices].sort(byMinutes),
    })),
  }));
export type ClubPricing = z.output<typeof clubPricingSchema>;
export type ClubPricingInput = z.input<typeof clubPricingSchema>;

/**
 * The price of a slot of `minutes` starting at `starts` (club local time) on
 * `day`: the band whose [starts, ends) contains the start time, otherwise the
 * standard price. Null when the club does not offer that slot length.
 * For booking (#23).
 */
export function priceForSlot(
  pricing: ClubPricing,
  day: Weekday,
  starts: TimeOfDay,
  minutes: number,
): { amountMinor: number; band: string | null } | null {
  if (!pricing.slotLengthsMinutes.includes(minutes)) return null;
  const at = minutesOfDay(starts);
  if (at === null) return null;
  const band = pricing.bands.find((b) => {
    const from = minutesOfDay(b.starts);
    const to = minutesOfDay(b.ends);
    return b.days.includes(day) && from !== null && to !== null && at >= from && at < to;
  });
  const price = (band?.prices ?? pricing.standardPrices).find((p) => p.minutes === minutes);
  return price ? { amountMinor: price.amountMinor, band: band?.label ?? null } : null;
}

/** True when a slot of `minutes` starting at `starts` on `day` fits inside the opening hours. For #23. */
export function isWithinOpeningHours(
  hours: OpeningHours,
  day: Weekday,
  starts: TimeOfDay,
  minutes: number,
): boolean {
  const today = hours[day];
  const at = minutesOfDay(starts);
  if (!today || at === null) return false;
  const opens = minutesOfDay(today.opens) ?? 0;
  const closes = minutesOfDay(today.closes) ?? 0;
  return at >= opens && at + minutes <= closes;
}

// ---------------------------------------------------------------------------
// Court blocks
// ---------------------------------------------------------------------------

export const COURT_BLOCK_REASONS = ["maintenance", "event", "other"] as const;
export const courtBlockReasonSchema = z.enum(COURT_BLOCK_REASONS, {
  error: "Choose maintenance, event or other",
});
export type CourtBlockReason = z.infer<typeof courtBlockReasonSchema>;

const localDateTimeSchema = (label: string) =>
  z
    .string({ error: `Enter the ${label} date and time` })
    .refine(isValidLocalDateTime, { error: `Enter the ${label} as YYYY-MM-DDTHH:MM` });

/**
 * POST /admin/clubs/:clubId/blocks, the shape only. Blocks the given courts
 * from `startsLocal` to `endsLocal`, wall-clock times in the club's time
 * zone. One block is created per court. The end must be after the start once
 * converted with the club's time zone: see `createCourtBlocksRequestSchemaIn`.
 */
export const createCourtBlocksRequestSchema = z.object({
  courtIds: z
    .array(z.uuid({ error: "Unknown court" }), { error: "Choose at least one court" })
    .min(1, { error: "Choose at least one court" })
    .max(MAX_COURTS_PER_BLOCK_REQUEST, { error: "Too many courts in one request" })
    .refine((ids) => new Set(ids).size === ids.length, { error: "Each court only once" }),
  startsLocal: localDateTimeSchema("start"),
  endsLocal: localDateTimeSchema("end"),
  reason: courtBlockReasonSchema,
  note: z
    .string()
    .trim()
    .max(COURT_BLOCK_NOTE_MAX_LENGTH, {
      error: `Keep the note to ${COURT_BLOCK_NOTE_MAX_LENGTH} characters or fewer`,
    })
    .optional()
    .transform((value) => (value ? value : null)),
});
export type CreateCourtBlocksRequest = z.input<typeof createCourtBlocksRequestSchema>;

/**
 * The block request with the rules that need the club's time zone: both
 * times exist there (not skipped by a clock change) and the end is after the
 * start. Adds `startsAt` and `endsAt` (UTC instants). In an ambiguous hour
 * (clocks going back) the earlier instant is used.
 */
export function createCourtBlocksRequestSchemaIn(timeZone: string) {
  return createCourtBlocksRequestSchema.transform((value, ctx) => {
    const starts = fromLocalDateTime(value.startsLocal, timeZone);
    const ends = fromLocalDateTime(value.endsLocal, timeZone);
    const skipped = `doesn't exist in ${timeZone} (the clocks go forward then)`;
    if (!starts.ok) {
      ctx.addIssue({
        code: "custom",
        path: ["startsLocal"],
        message: `That start time ${skipped}`,
      });
    }
    if (!ends.ok) {
      ctx.addIssue({ code: "custom", path: ["endsLocal"], message: `That end time ${skipped}` });
    }
    if (!starts.ok || !ends.ok) return z.NEVER;
    if (ends.instant.getTime() <= starts.instant.getTime()) {
      ctx.addIssue({
        code: "custom",
        path: ["endsLocal"],
        message: "The block must end after it starts",
      });
      return z.NEVER;
    }
    return { ...value, startsAt: starts.instant, endsAt: ends.instant };
  });
}

export const courtBlockSchema = z.object({
  id: z.uuid(),
  clubId: z.uuid(),
  courtId: z.uuid(),
  reason: courtBlockReasonSchema,
  note: z.string().nullable(),
  /** UTC instants. */
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  /** The same instants as wall-clock times in the club's time zone. */
  startsLocal: z.string(),
  endsLocal: z.string(),
  createdAt: z.iso.datetime(),
  /** Set when staff removed the block; it no longer blocks anything. */
  cancelledAt: z.iso.datetime().nullable(),
});
export type CourtBlock = z.infer<typeof courtBlockSchema>;

const booleanQuery = z
  .enum(["true", "false"], { error: "Use true or false" })
  .transform((value) => value === "true");

/**
 * GET /admin/clubs/:clubId/blocks query. Blocks that overlap [from, to).
 * `from` defaults to now (so past blocks are hidden), `to` to no limit.
 */
export const listCourtBlocksQuerySchema = z.object({
  from: z.iso.datetime({ offset: true, error: "from must be an ISO 8601 date-time" }).optional(),
  to: z.iso.datetime({ offset: true, error: "to must be an ISO 8601 date-time" }).optional(),
  courtId: z.uuid({ error: "Unknown court" }).optional(),
  includeCancelled: booleanQuery.optional(),
});

/** GET /clubs/:clubId/blocks query: both required, `to` after `from`, at most 62 days apart. */
export const publicCourtBlocksQuerySchema = z
  .object({
    from: z.iso.datetime({ offset: true, error: "from must be an ISO 8601 date-time" }),
    to: z.iso.datetime({ offset: true, error: "to must be an ISO 8601 date-time" }),
  })
  .superRefine((value, ctx) => {
    const from = Date.parse(value.from);
    const to = Date.parse(value.to);
    if (to <= from) {
      ctx.addIssue({ code: "custom", path: ["to"], message: "to must be after from" });
    } else if (to - from > PUBLIC_BLOCKS_MAX_RANGE_DAYS * 86_400_000) {
      ctx.addIssue({
        code: "custom",
        path: ["to"],
        message: `Ask for at most ${PUBLIC_BLOCKS_MAX_RANGE_DAYS} days at a time`,
      });
    }
  });

/** What members' apps see of a block: when a court is unavailable, not why. */
export const publicCourtBlockSchema = z.object({
  courtId: z.uuid(),
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
});
export type PublicCourtBlock = z.infer<typeof publicCourtBlockSchema>;

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

/** One row of GET /admin/clubs. */
export const adminClubSummarySchema = clubSchema.extend({
  courtCount: z.int().min(0),
  activeCourtCount: z.int().min(0),
  hasPricing: z.boolean(),
});
export type AdminClubSummary = z.infer<typeof adminClubSummarySchema>;

/** 200 from GET /admin/clubs: every club, active or not, ordered by name. */
export const adminClubListResponseSchema = z.object({ clubs: z.array(adminClubSummarySchema) });
export type AdminClubListResponse = z.infer<typeof adminClubListResponseSchema>;

/** 200 from GET /admin/clubs/:clubId: the club, all its courts (active or not) and its pricing. */
export const adminClubDetailResponseSchema = z.object({
  club: clubSchema,
  courts: z.array(courtSchema),
  pricing: clubPricingSchema.nullable(),
});
export type AdminClubDetailResponse = z.infer<typeof adminClubDetailResponseSchema>;

/** 201 from POST /admin/clubs, 200 from PATCH /admin/clubs/:clubId. */
export const clubResponseSchema = z.object({ club: clubSchema });
export type ClubResponse = z.infer<typeof clubResponseSchema>;

/** 201 from POST .../courts, 200 from PATCH .../courts/:courtId. */
export const courtResponseSchema = z.object({ court: courtSchema });
export type CourtResponse = z.infer<typeof courtResponseSchema>;

/** 200 from PUT /admin/clubs/:clubId/pricing. */
export const pricingResponseSchema = z.object({ pricing: clubPricingSchema });
export type PricingResponse = z.infer<typeof pricingResponseSchema>;

/** 201 from POST /admin/clubs/:clubId/blocks, 200 from GET of the same path. */
export const courtBlockListResponseSchema = z.object({ blocks: z.array(courtBlockSchema) });
export type CourtBlockListResponse = z.infer<typeof courtBlockListResponseSchema>;

/** 200 from GET /clubs: active clubs, ordered by name. */
export const publicClubListResponseSchema = z.object({ clubs: z.array(clubSchema) });
export type PublicClubListResponse = z.infer<typeof publicClubListResponseSchema>;

/** 200 from GET /clubs/:clubId: an active club, its active courts and its pricing. */
export const publicClubDetailResponseSchema = z.object({
  club: clubSchema,
  courts: z.array(courtSchema),
  pricing: clubPricingSchema.nullable(),
});
export type PublicClubDetailResponse = z.infer<typeof publicClubDetailResponseSchema>;

/** 200 from GET /clubs/:clubId/blocks. */
export const publicCourtBlockListResponseSchema = z.object({
  blocks: z.array(publicCourtBlockSchema),
});
export type PublicCourtBlockListResponse = z.infer<typeof publicCourtBlockListResponseSchema>;
