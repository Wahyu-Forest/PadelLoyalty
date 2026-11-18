import { describe, expect, it } from "vitest";
import { DEFAULT_API_URL, resolveApiUrl } from "./config";

describe("resolveApiUrl", () => {
  it("falls back to the local API when unset or blank", () => {
    expect(resolveApiUrl(undefined)).toBe(DEFAULT_API_URL);
    expect(resolveApiUrl("   ")).toBe(DEFAULT_API_URL);
  });

  it("trims whitespace and trailing slashes", () => {
    expect(resolveApiUrl(" https://api.soulpadel.example/ ")).toBe("https://api.soulpadel.example");
    expect(resolveApiUrl("http://10.0.2.2:4000//")).toBe("http://10.0.2.2:4000");
  });
});
