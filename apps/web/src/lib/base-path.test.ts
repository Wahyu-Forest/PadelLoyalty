import { describe, expect, it } from "vitest";
import { resolveBasePath } from "./base-path";

describe("resolveBasePath", () => {
  it("serves from the root when unset or blank (Capacitor and local builds)", () => {
    expect(resolveBasePath(undefined)).toBe("");
    expect(resolveBasePath("")).toBe("");
    expect(resolveBasePath("  ")).toBe("");
    expect(resolveBasePath("/")).toBe("");
  });

  it("normalises a subpath to a leading slash and no trailing slash", () => {
    expect(resolveBasePath("/PadelLoyalty")).toBe("/PadelLoyalty");
    expect(resolveBasePath("/PadelLoyalty/")).toBe("/PadelLoyalty");
    expect(resolveBasePath(" PadelLoyalty ")).toBe("/PadelLoyalty");
    expect(resolveBasePath("//nested/path//")).toBe("/nested/path");
  });

  it("rejects a full URL, which belongs in an asset prefix, not a base path", () => {
    expect(() => resolveBasePath("https://example.com/PadelLoyalty")).toThrow(
      /NEXT_PUBLIC_BASE_PATH/,
    );
  });
});
