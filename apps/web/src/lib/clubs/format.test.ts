import { describe, expect, it } from "vitest";
import { formatLocalDateTime, timeZoneOptions } from "./format";

describe("formatLocalDateTime", () => {
  it("formats a wall-clock date and time", () => {
    expect(formatLocalDateTime("2026-12-01T09:00")).toBe("Tue 1 Dec 2026, 09:00");
    expect(formatLocalDateTime("2027-03-28T23:45")).toBe("Sun 28 Mar 2027, 23:45");
  });
});

describe("timeZoneOptions", () => {
  it("includes London and UTC", () => {
    const zones = timeZoneOptions();
    expect(zones).toContain("Europe/London");
    expect(zones).toContain("UTC");
  });
});
