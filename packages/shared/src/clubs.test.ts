import { describe, expect, it } from "vitest";
import {
  canAccessBackOffice,
  canSetUpClubs,
  clubPricingSchema,
  createCourtBlocksRequestSchemaIn,
  isWithinOpeningHours,
  openingHoursSchema,
  priceForSlot,
  type ClubPricingInput,
} from "./clubs.js";

const PRICING: ClubPricingInput = {
  slotLengthsMinutes: [60, 90],
  standardPrices: [
    { minutes: 60, amountMinor: 3000 },
    { minutes: 90, amountMinor: 4200 },
  ],
  bands: [
    {
      label: "Peak",
      days: ["mon", "tue", "wed", "thu", "fri"],
      starts: "17:00",
      ends: "22:00",
      prices: [
        { minutes: 60, amountMinor: 4000 },
        { minutes: 90, amountMinor: 5600 },
      ],
    },
    {
      label: "Weekend",
      days: ["sat", "sun"],
      starts: "00:00",
      ends: "24:00",
      prices: [
        { minutes: 60, amountMinor: 3500 },
        { minutes: 90, amountMinor: 5000 },
      ],
    },
  ],
};

describe("roles", () => {
  it("lets staff into the back office and only admins set up clubs", () => {
    expect(canAccessBackOffice("member")).toBe(false);
    expect(canAccessBackOffice("receptionist")).toBe(true);
    expect(canAccessBackOffice("club_manager")).toBe(true);
    expect(canAccessBackOffice("admin")).toBe(true);
    expect(canSetUpClubs("club_manager")).toBe(false);
    expect(canSetUpClubs("admin")).toBe(true);
  });
});

describe("pricing", () => {
  const pricing = clubPricingSchema.parse(PRICING);

  it("prices a slot by the band containing its start time, else the standard price", () => {
    expect(priceForSlot(pricing, "mon", "17:00", 60)).toEqual({ amountMinor: 4000, band: "Peak" });
    expect(priceForSlot(pricing, "mon", "21:45", 90)).toEqual({ amountMinor: 5600, band: "Peak" });
    expect(priceForSlot(pricing, "mon", "16:30", 90)).toEqual({ amountMinor: 4200, band: null });
    expect(priceForSlot(pricing, "mon", "22:00", 60)).toEqual({ amountMinor: 3000, band: null });
    expect(priceForSlot(pricing, "sun", "09:00", 60)).toEqual({
      amountMinor: 3500,
      band: "Weekend",
    });
    expect(priceForSlot(pricing, "mon", "10:00", 120)).toBeNull();
  });

  it("allows bands on different days at the same time, and touching bands", () => {
    const ok = clubPricingSchema.safeParse({
      ...PRICING,
      bands: [
        { ...PRICING.bands![0]!, days: ["mon"], starts: "17:00", ends: "19:00" },
        { ...PRICING.bands![0]!, label: "Late", days: ["mon"], starts: "19:00", ends: "22:00" },
        { ...PRICING.bands![0]!, label: "Tue", days: ["tue"], starts: "17:00", ends: "22:00" },
      ],
    });
    expect(ok.success, JSON.stringify(ok.error?.issues)).toBe(true);
  });

  it("rejects overlapping bands, naming both and the day", () => {
    const result = clubPricingSchema.safeParse({
      ...PRICING,
      bands: [
        PRICING.bands![0]!,
        {
          ...PRICING.bands![0]!,
          label: "Evening",
          days: ["fri", "sat"],
          starts: "21:00",
          ends: "23:00",
        },
      ],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.message)).toContain(
      'Band "Evening" overlaps band "Peak" on Friday',
    );
  });

  it("rejects duplicate days in a band", () => {
    const result = clubPricingSchema.safeParse({
      ...PRICING,
      bands: [{ ...PRICING.bands![0]!, days: ["mon", "mon"] }],
    });
    expect(result.success).toBe(false);
  });
});

describe("opening hours", () => {
  const week = {
    mon: { opens: "07:00", closes: "23:00" },
    tue: null,
    wed: null,
    thu: null,
    fri: null,
    sat: null,
    sun: { opens: "09:00", closes: "24:00" },
  };

  it("checks that a slot fits inside opening hours", () => {
    const hours = openingHoursSchema.parse(week);
    expect(isWithinOpeningHours(hours, "mon", "07:00", 60)).toBe(true);
    expect(isWithinOpeningHours(hours, "mon", "22:00", 60)).toBe(true);
    expect(isWithinOpeningHours(hours, "mon", "22:00", 90)).toBe(false);
    expect(isWithinOpeningHours(hours, "sun", "22:30", 90)).toBe(true);
    expect(isWithinOpeningHours(hours, "tue", "10:00", 60)).toBe(false);
    expect(isWithinOpeningHours(hours, "mon", "06:45", 60)).toBe(false);
  });
});

describe("court block times", () => {
  const base = {
    courtIds: ["2b0b5a6e-8a39-4a8f-9a53-4a0f4f6f1a11"],
    reason: "maintenance",
  };

  it("converts with the club's time zone", () => {
    const parsed = createCourtBlocksRequestSchemaIn("Europe/London").parse({
      ...base,
      startsLocal: "2027-07-01T09:00",
      endsLocal: "2027-07-01T10:00",
      note: "",
    });
    expect(parsed.startsAt.toISOString()).toBe("2027-07-01T08:00:00.000Z");
    expect(parsed.endsAt.toISOString()).toBe("2027-07-01T09:00:00.000Z");
    expect(parsed.note).toBeNull();
  });

  it("compares the instants, not the text, across the clocks going back", () => {
    // 01:45 BST (00:45Z) to 01:15 GMT would be later, but 01:15 resolves to the
    // earlier (BST) instant, 00:15Z, so the end is before the start.
    const result = createCourtBlocksRequestSchemaIn("Europe/London").safeParse({
      ...base,
      startsLocal: "2026-10-25T01:45",
      endsLocal: "2026-10-25T01:15",
    });
    expect(result.success).toBe(false);
  });
});
