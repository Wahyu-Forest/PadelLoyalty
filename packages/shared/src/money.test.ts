import { describe, expect, it } from "vitest";
import {
  formatMoney,
  isValidCurrency,
  minorToDecimalString,
  minorUnitDigits,
  parseMoney,
} from "./money.js";

describe("money", () => {
  it("validates ISO currency codes", () => {
    expect(isValidCurrency("GBP")).toBe(true);
    expect(isValidCurrency("IDR")).toBe(true);
    expect(isValidCurrency("gbp")).toBe(false);
    expect(isValidCurrency("POUND")).toBe(false);
    expect(isValidCurrency("")).toBe(false);
    // QA #56: well-formed but unassigned codes were accepted.
    for (const code of ["ABC", "QQQ", "ZZZ"]) expect(isValidCurrency(code), code).toBe(false);
    expect(isValidCurrency("JPY")).toBe(true);
  });

  it("knows minor-unit digits", () => {
    expect(minorUnitDigits("GBP")).toBe(2);
    expect(minorUnitDigits("JPY")).toBe(0);
  });

  it("parses decimal text into integer minor units without floats", () => {
    expect(parseMoney("30", "GBP")).toBe(3000);
    expect(parseMoney("12.5", "GBP")).toBe(1250);
    expect(parseMoney(" 0.07 ", "GBP")).toBe(7);
    // 0.1 + 0.2 style rounding problems can't happen: the digits are joined as text.
    expect(parseMoney("19.99", "GBP")).toBe(1999);
    expect(parseMoney("1000", "JPY")).toBe(1000);
    for (const bad of ["", "-1", "1.234", "1,50", "abc", "1.5.0", "1e3"]) {
      expect(parseMoney(bad, "GBP"), bad).toBeNull();
    }
    expect(parseMoney("1.5", "JPY")).toBeNull();
  });

  it("formats minor units for editing and display", () => {
    expect(minorToDecimalString(1250, "GBP")).toBe("12.50");
    expect(minorToDecimalString(5, "GBP")).toBe("0.05");
    expect(minorToDecimalString(0, "GBP")).toBe("0.00");
    expect(minorToDecimalString(1000, "JPY")).toBe("1000");
    expect(formatMoney(1250, "GBP")).toBe("£12.50");
    expect(formatMoney(4000, "EUR")).toBe("€40.00");
  });
});
