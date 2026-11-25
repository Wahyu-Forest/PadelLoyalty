import { describe, expect, it } from "vitest";
import {
  CREDIT_ENTRY_TYPES,
  DEBIT_ENTRY_TYPES,
  IDEMPOTENCY_KEY_MAX_LENGTH,
  POINTS_ENTRY_MAX_AMOUNT,
  POINTS_ENTRY_TYPES,
  idempotencyKeySchema,
  pointsAmountSchema,
  pointsBalanceResponseSchema,
  pointsReasonSchema,
} from "./index.js";

describe("entry types", () => {
  it("covers earn, redeem, adjustment and expiry; credits and debits are subsets", () => {
    expect(POINTS_ENTRY_TYPES).toEqual(["earn", "redeem", "adjustment", "expiry"]);
    expect(CREDIT_ENTRY_TYPES).toEqual(["earn", "adjustment"]);
    expect(DEBIT_ENTRY_TYPES).toEqual(["redeem", "adjustment", "expiry"]);
  });
});

describe("pointsAmountSchema", () => {
  it.each([1, 250, POINTS_ENTRY_MAX_AMOUNT])("accepts %s", (amount) => {
    expect(pointsAmountSchema.safeParse(amount).success).toBe(true);
  });

  it.each([0, -1, 1.5, POINTS_ENTRY_MAX_AMOUNT + 1, Number.NaN, Infinity, "5"])(
    "rejects %s",
    (amount) => {
      expect(pointsAmountSchema.safeParse(amount).success).toBe(false);
    },
  );
});

describe("idempotencyKeySchema", () => {
  it("accepts event-derived keys", () => {
    expect(idempotencyKeySchema.safeParse("checkin:b-1:u-2").success).toBe(true);
    expect(idempotencyKeySchema.safeParse("x".repeat(IDEMPOTENCY_KEY_MAX_LENGTH)).success).toBe(
      true,
    );
  });

  it.each(["", " ", "has space", "tab\tkey", "é", "x".repeat(IDEMPOTENCY_KEY_MAX_LENGTH + 1)])(
    "rejects %j",
    (key) => {
      expect(idempotencyKeySchema.safeParse(key).success).toBe(false);
    },
  );
});

describe("pointsReasonSchema", () => {
  it("trims and requires text", () => {
    expect(pointsReasonSchema.parse("  Welcome bonus ")).toBe("Welcome bonus");
    expect(pointsReasonSchema.safeParse("   ").success).toBe(false);
    expect(pointsReasonSchema.safeParse("x".repeat(501)).success).toBe(false);
  });
});

describe("pointsBalanceResponseSchema", () => {
  it("parses a balance", () => {
    const body = { balance: 1250, asOf: "2026-11-24T10:00:00.000Z" };
    expect(pointsBalanceResponseSchema.parse(body)).toEqual(body);
  });

  it("rejects fractional or missing balances", () => {
    const asOf = "2026-11-24T10:00:00.000Z";
    expect(pointsBalanceResponseSchema.safeParse({ balance: 1.5, asOf }).success).toBe(false);
    expect(pointsBalanceResponseSchema.safeParse({ asOf }).success).toBe(false);
  });
});
