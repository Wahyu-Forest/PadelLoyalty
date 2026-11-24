import { describe, expect, it } from "vitest";
import { safeNextPath } from "./safe-next";

describe("safeNextPath", () => {
  it.each(["/admin/", "/admin/club/?id=abc", "/"])("allows %s", (path) => {
    expect(safeNextPath(path)).toBe(path);
  });

  it.each([
    null,
    undefined,
    "",
    "admin/",
    "//evil.example/",
    "/\\evil.example",
    "https://evil.example/",
    "/x?u=https://evil.example",
    "/ admin",
    "javascript:alert(1)",
  ])("refuses %j", (path) => {
    expect(safeNextPath(path)).toBeNull();
  });
});
