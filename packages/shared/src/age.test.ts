import { describe, expect, it } from "vitest";
import {
  ADULT_AGE,
  ageOn,
  calendarDateLocal,
  calendarDateUtc,
  isValidCalendarDate,
  needsGuardianConsent,
  parseCalendarDate,
} from "./index.js";

describe("ADULT_AGE", () => {
  it("is 18", () => {
    expect(ADULT_AGE).toBe(18);
  });
});

describe("parseCalendarDate / isValidCalendarDate", () => {
  it.each(["2008-01-31", "2024-02-29", "2000-02-29", "1900-01-01", "2010-12-31"])(
    "accepts %s",
    (value) => {
      expect(isValidCalendarDate(value)).toBe(true);
    },
  );

  it.each([
    ["not a leap year", "2025-02-29"],
    ["1900 is not a leap year", "1900-02-29"],
    ["30 February", "2024-02-30"],
    ["31 April", "2024-04-31"],
    ["month 13", "2024-13-01"],
    ["month 0", "2024-00-10"],
    ["day 0", "2024-01-00"],
    ["no padding", "2024-1-5"],
    ["other format", "05/01/2024"],
    ["with time", "2024-01-05T00:00:00Z"],
    ["empty", ""],
    ["year 0", "0000-01-01"],
  ])("rejects %s (%s)", (_label, value) => {
    expect(isValidCalendarDate(value)).toBe(false);
  });

  it("returns the parts", () => {
    expect(parseCalendarDate("2008-03-09")).toEqual({ year: 2008, month: 3, day: 9 });
  });
});

describe("ageOn", () => {
  it("goes up on the birthday itself, not the day before", () => {
    expect(ageOn("2008-06-15", "2026-06-14")).toBe(17);
    expect(ageOn("2008-06-15", "2026-06-15")).toBe(18);
    expect(ageOn("2008-06-15", "2026-06-16")).toBe(18);
  });

  it("handles the month boundary (born late in a month)", () => {
    expect(ageOn("2008-01-31", "2026-01-30")).toBe(17);
    expect(ageOn("2008-01-31", "2026-02-01")).toBe(18);
  });

  it("counts a 29 February birthday from 1 March in non-leap years", () => {
    expect(ageOn("2008-02-29", "2026-02-28")).toBe(17);
    expect(ageOn("2008-02-29", "2026-03-01")).toBe(18);
  });

  it("counts a 29 February birthday on 29 February in leap years", () => {
    expect(ageOn("2012-02-29", "2028-02-28")).toBe(15);
    expect(ageOn("2012-02-29", "2028-02-29")).toBe(16);
  });

  it("is 0 on the day of birth", () => {
    expect(ageOn("2026-11-24", "2026-11-24")).toBe(0);
  });

  it("throws for invalid or future dates", () => {
    expect(() => ageOn("2025-02-29", "2026-01-01")).toThrow(RangeError);
    expect(() => ageOn("2026-01-02", "2026-01-01")).toThrow(RangeError);
  });
});

describe("needsGuardianConsent", () => {
  it("is true until the 18th birthday", () => {
    expect(needsGuardianConsent("2008-11-25", "2026-11-24")).toBe(true);
    expect(needsGuardianConsent("2008-11-24", "2026-11-24")).toBe(false);
    expect(needsGuardianConsent("1980-01-01", "2026-11-24")).toBe(false);
  });
});

describe("calendar dates of an instant", () => {
  it("calendarDateUtc uses UTC", () => {
    expect(calendarDateUtc(new Date("2026-11-24T23:59:59.999Z"))).toBe("2026-11-24");
    expect(calendarDateUtc(new Date("2026-11-25T00:00:00.000Z"))).toBe("2026-11-25");
  });

  it("calendarDateLocal uses the local time zone", () => {
    const instant = new Date(2026, 0, 5, 12, 0, 0);
    expect(calendarDateLocal(instant)).toBe("2026-01-05");
  });
});
