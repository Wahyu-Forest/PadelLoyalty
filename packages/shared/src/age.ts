/**
 * Dates of birth and age (issue #3). Pure functions on calendar dates
 * (`YYYY-MM-DD` strings), so the web app and the API compute the same age.
 * No `Date` arithmetic: time zones and daylight saving cannot shift a birthday.
 */

/** Members younger than this need a parent or guardian's consent. Defined once, here. */
export const ADULT_AGE = 18;

/** Earliest date of birth accepted at sign-up. Anything before is treated as a typo. */
export const EARLIEST_DATE_OF_BIRTH = "1900-01-01";

/** A calendar date as `YYYY-MM-DD`. */
export type CalendarDate = string;

const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface DateParts {
  year: number;
  month: number;
  day: number;
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** Parses `YYYY-MM-DD`; null for anything else, including dates that don't exist (2025-02-29). */
export function parseCalendarDate(value: string): DateParts | null {
  const match = CALENDAR_DATE.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    return null;
  }
  return { year, month, day };
}

export function isValidCalendarDate(value: string): boolean {
  return parseCalendarDate(value) !== null;
}

/** The calendar date of an instant in UTC, as `YYYY-MM-DD`. */
export function calendarDateUtc(instant: Date): CalendarDate {
  return instant.toISOString().slice(0, 10);
}

/** The calendar date of an instant in the device's local time zone, as `YYYY-MM-DD`. */
export function calendarDateLocal(instant: Date): CalendarDate {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${instant.getFullYear()}-${pad(instant.getMonth() + 1)}-${pad(instant.getDate())}`;
}

/**
 * Completed years between `dateOfBirth` and `today` (both `YYYY-MM-DD`).
 *
 * The age goes up on the birthday itself. Someone born on 29 February gets
 * one year older on 1 March in years without a 29 February (the later of the
 * two common conventions, so a junior is never treated as an adult early).
 * Throws on an invalid date, and on a date of birth after `today`.
 */
export function ageOn(dateOfBirth: CalendarDate, today: CalendarDate): number {
  const born = parseCalendarDate(dateOfBirth);
  const now = parseCalendarDate(today);
  if (!born) throw new RangeError(`Invalid date of birth: ${dateOfBirth}`);
  if (!now) throw new RangeError(`Invalid date: ${today}`);
  if (dateOfBirth > today) throw new RangeError(`Date of birth ${dateOfBirth} is after ${today}`);
  const hadBirthday = now.month > born.month || (now.month === born.month && now.day >= born.day);
  return now.year - born.year - (hadBirthday ? 0 : 1);
}

/** True when a member with this date of birth needs guardian consent on `today`. */
export function needsGuardianConsent(dateOfBirth: CalendarDate, today: CalendarDate): boolean {
  return ageOn(dateOfBirth, today) < ADULT_AGE;
}
