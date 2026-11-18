import { describe, expect, it } from "vitest";
import { healthResponseSchema } from "./index.js";

describe("healthResponseSchema", () => {
  it("accepts a healthy response", () => {
    const body = { status: "ok", database: "up", timestamp: "2026-11-18T10:00:00.000Z" };
    expect(healthResponseSchema.parse(body)).toEqual(body);
  });

  it("accepts a degraded response with the database down", () => {
    const body = { status: "degraded", database: "down", timestamp: "2026-11-18T10:00:00.000Z" };
    expect(healthResponseSchema.safeParse(body).success).toBe(true);
  });

  it("rejects an unknown status", () => {
    const result = healthResponseSchema.safeParse({
      status: "fine",
      database: "up",
      timestamp: "2026-11-18T10:00:00.000Z",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a missing or malformed timestamp", () => {
    expect(healthResponseSchema.safeParse({ status: "ok", database: "up" }).success).toBe(false);
    expect(
      healthResponseSchema.safeParse({ status: "ok", database: "up", timestamp: "yesterday" })
        .success,
    ).toBe(false);
  });
});
