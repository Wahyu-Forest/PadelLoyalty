import { describe, expect, it } from "vitest";
import { LOYALTY_PROGRAMME_NAME, POINTS_NAME } from "./branding.js";

describe("branding", () => {
  it("names the points currency in one place", () => {
    expect(POINTS_NAME).toBe("Soul points");
    expect(LOYALTY_PROGRAMME_NAME).toContain(POINTS_NAME);
  });
});
