import { describe, expect, it } from "vitest";
import {
  fromLocalDateTime,
  isValidLocalDateTime,
  isValidTimeZone,
  minutesOfDay,
  timeOfDay,
  toLocalDateTime,
  weekdayOf,
} from "./zoned-time.js";

describe("isValidTimeZone", () => {
  it.each(["Europe/London", "Asia/Jakarta", "UTC", "America/Argentina/Buenos_Aires", "Etc/GMT+1"])(
    "accepts %s",
    (zone) => expect(isValidTimeZone(zone)).toBe(true),
  );
  it.each(["+01:00", "BST", "GMT", "Europe/Atlantis", "europe/london", "", "Europe/London "])(
    "rejects %j",
    (zone) => expect(isValidTimeZone(zone)).toBe(false),
  );
});

describe("times of day", () => {
  it("parses HH:MM and 24:00", () => {
    expect(minutesOfDay("00:00")).toBe(0);
    expect(minutesOfDay("17:30")).toBe(1050);
    expect(minutesOfDay("24:00")).toBe(1440);
    expect(minutesOfDay("24:15")).toBeNull();
    expect(minutesOfDay("7:00")).toBeNull();
    expect(minutesOfDay("12:60")).toBeNull();
    expect(timeOfDay(1440)).toBe("24:00");
    expect(timeOfDay(65)).toBe("01:05");
  });

  it("validates local date-times", () => {
    expect(isValidLocalDateTime("2026-12-01T09:00")).toBe(true);
    expect(isValidLocalDateTime("2026-02-29T09:00")).toBe(false);
    expect(isValidLocalDateTime("2026-12-01T24:00")).toBe(false);
    expect(isValidLocalDateTime("2026-12-01 09:00")).toBe(false);
    expect(isValidLocalDateTime("2026-12-01T09:00:00")).toBe(false);
  });

  it("gives the weekday of a date", () => {
    expect(weekdayOf("2026-11-24")).toBe("tue");
    expect(weekdayOf("2026-11-29")).toBe("sun");
    expect(weekdayOf("2026-11-30")).toBe("mon");
  });
});

describe("local time <-> UTC", () => {
  it("converts in winter and summer (Europe/London)", () => {
    expect(fromLocalDateTime("2026-12-01T09:00", "Europe/London")).toEqual({
      ok: true,
      instant: new Date("2026-12-01T09:00:00Z"),
    });
    expect(fromLocalDateTime("2026-07-01T09:00", "Europe/London")).toEqual({
      ok: true,
      instant: new Date("2026-07-01T08:00:00Z"),
    });
    expect(toLocalDateTime(new Date("2026-07-01T08:00:00Z"), "Europe/London")).toBe(
      "2026-07-01T09:00",
    );
  });

  it("handles zones east of UTC and across midnight", () => {
    expect(fromLocalDateTime("2026-12-01T05:00", "Asia/Jakarta")).toEqual({
      ok: true,
      instant: new Date("2026-11-30T22:00:00Z"),
    });
    expect(toLocalDateTime(new Date("2026-11-30T22:00:00Z"), "Asia/Jakarta")).toBe(
      "2026-12-01T05:00",
    );
  });

  it("reports times skipped when the clocks go forward", () => {
    expect(fromLocalDateTime("2027-03-28T01:30", "Europe/London")).toEqual({
      ok: false,
      reason: "nonexistent",
    });
    expect(fromLocalDateTime("2027-03-28T02:00", "Europe/London").ok).toBe(true);
  });

  it("uses the earlier instant for a repeated time when the clocks go back", () => {
    expect(fromLocalDateTime("2026-10-25T01:30", "Europe/London")).toEqual({
      ok: true,
      instant: new Date("2026-10-25T00:30:00Z"),
    });
  });

  it("rejects malformed input", () => {
    expect(fromLocalDateTime("2026-12-01", "Europe/London")).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(fromLocalDateTime("2026-12-01T09:00", "Nowhere/Here")).toEqual({
      ok: false,
      reason: "invalid",
    });
  });
});
