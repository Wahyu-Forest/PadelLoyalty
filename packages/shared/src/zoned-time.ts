/**
 * Wall-clock times in a club's IANA time zone (issue #56).
 *
 * Opening hours, price bands and court blocks are entered in the club's local
 * time; the API stores block instants in UTC. These helpers convert between
 * the two with `Intl` only (no date library), so the web app and the API agree.
 */
import { parseCalendarDate, type CalendarDate } from "./age.js";

/** Weekdays, Monday first (ISO 8601 order). */
export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export const WEEKDAY_LABELS: Record<Weekday, string> = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
};

/** A time of day `HH:MM`, 00:00 to 23:59, or `24:00` for the end of the day. */
export type TimeOfDay = string;

const TIME_OF_DAY = /^(?:([01]\d|2[0-3]):([0-5]\d)|24:00)$/;

/** Minutes since midnight for `HH:MM` (`24:00` is 1440); null when malformed. */
export function minutesOfDay(value: string): number | null {
  if (!TIME_OF_DAY.test(value)) return null;
  const [hours, minutes] = value.split(":").map(Number) as [number, number];
  return hours * 60 + minutes;
}

/** `HH:MM` for minutes since midnight (1440 gives `24:00`). */
export function timeOfDay(minutes: number): TimeOfDay {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

/**
 * IANA zone names in `Area/Location` form (`Europe/London`,
 * `America/Argentina/Buenos_Aires`) or `UTC`. Offsets such as `+01:00` and
 * abbreviations such as `BST` are not accepted: they don't follow daylight saving.
 */
const IANA_ZONE_NAME = /^(?:UTC|[A-Z][A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){1,2})$/;

/** True for an IANA time zone this JavaScript runtime knows, e.g. `Europe/London`. */
export function isValidTimeZone(value: string): boolean {
  if (!IANA_ZONE_NAME.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** The default for new clubs. */
export const DEFAULT_TIME_ZONE = "Europe/London";

/** A wall-clock date and time `YYYY-MM-DDTHH:MM` (what `<input type="datetime-local">` gives). */
export type LocalDateTime = string;

const LOCAL_DATE_TIME = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d)$/;

export function isValidLocalDateTime(value: string): boolean {
  const match = LOCAL_DATE_TIME.exec(value);
  return !!match && parseCalendarDate(match[1]!) !== null;
}

/** The weekday of a calendar date `YYYY-MM-DD`. */
export function weekdayOf(date: CalendarDate): Weekday {
  const parts = parseCalendarDate(date);
  if (!parts) throw new RangeError(`Not a calendar date: ${date}`);
  const sundayFirst = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
  return WEEKDAYS[(sundayFirst + 6) % 7]!;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

function wallClock(instantMs: number, timeZone: string) {
  const parts: Record<string, number> = {};
  for (const part of formatterFor(timeZone).formatToParts(new Date(instantMs))) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return {
    year: parts.year!,
    month: parts.month!,
    day: parts.day!,
    // Some engines print midnight as 24 even with h23.
    hour: parts.hour! % 24,
    minute: parts.minute!,
    second: parts.second!,
  };
}

/** The wall-clock date and time of an instant in `timeZone`, to the minute. */
export function toLocalDateTime(instant: Date, timeZone: string): LocalDateTime {
  const c = wallClock(instant.getTime(), timeZone);
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return `${pad(c.year, 4)}-${pad(c.month)}-${pad(c.day)}T${pad(c.hour)}:${pad(c.minute)}`;
}

/** UTC offset of `timeZone` at an instant, in minutes (Europe/London in summer: 60). */
function offsetMinutesAt(instantMs: number, timeZone: string): number {
  const c = wallClock(instantMs, timeZone);
  const asUtc = Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute, c.second);
  return Math.round((asUtc - Math.floor(instantMs / 1000) * 1000) / 60_000);
}

export type ZonedConversion =
  | { ok: true; instant: Date }
  /** The wall-clock time is skipped when the clocks go forward (e.g. 01:30 on the last Sunday of March in London). */
  | { ok: false; reason: "nonexistent" | "invalid" };

/**
 * The instant at which the clocks in `timeZone` show `local`.
 *
 * When the clocks go back, a wall-clock time happens twice; the **earlier**
 * instant is used. When they go forward, a skipped time gives `nonexistent`.
 */
export function fromLocalDateTime(local: LocalDateTime, timeZone: string): ZonedConversion {
  const match = LOCAL_DATE_TIME.exec(local);
  const date = match ? parseCalendarDate(match[1]!) : null;
  if (!match || !date || !isValidTimeZone(timeZone)) return { ok: false, reason: "invalid" };
  const naive = Date.UTC(date.year, date.month - 1, date.day, Number(match[2]), Number(match[3]));
  const DAY = 86_400_000;
  const offsets = new Set(
    [naive - DAY, naive, naive + DAY].map((at) => offsetMinutesAt(at, timeZone)),
  );
  const matches = [...offsets]
    .map((offset) => naive - offset * 60_000)
    .filter((instant) => toLocalDateTime(new Date(instant), timeZone) === local)
    .sort((a, b) => a - b);
  if (matches.length === 0) return { ok: false, reason: "nonexistent" };
  return { ok: true, instant: new Date(matches[0]!) };
}
