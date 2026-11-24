import { describe, expect, it } from "vitest";
import {
  ACCOUNT_STATUSES,
  API_ERROR_CODES,
  CONSENT_STATES,
  SAFEGUARDING_POLICY_PLACEHOLDER,
  consentDecisionRequestSchema,
  consentRequestRequestSchema,
  consentStatusResponseSchema,
  isAccountFullyActive,
  signUpRequestSchema,
  signUpRequestSchemaOn,
} from "./index.js";

const TODAY = "2026-11-24";
const base = { email: "kid@example.com", password: "correct horse battery" };

function fieldErrors(result: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }) {
  return (result.error?.issues ?? []).map((issue) => String(issue.path[0]));
}

describe("account statuses", () => {
  it("adds pending_consent; only active is fully active", () => {
    expect(ACCOUNT_STATUSES).toEqual(["pending_verification", "pending_consent", "active"]);
    expect(isAccountFullyActive("active")).toBe(true);
    expect(isAccountFullyActive("pending_consent")).toBe(false);
    expect(isAccountFullyActive("pending_verification")).toBe(false);
  });

  it("has the new error codes", () => {
    expect(API_ERROR_CODES).toEqual(
      expect.arrayContaining(["account_not_active", "consent_not_required", "guardian_declined"]),
    );
  });
});

describe("signUpRequestSchema (shape)", () => {
  it("requires a date of birth", () => {
    const result = signUpRequestSchema.safeParse(base);
    expect(result.success).toBe(false);
    expect(fieldErrors(result)).toContain("dateOfBirth");
  });

  it.each(["2025-02-29", "2024-13-01", "24-01-01", "1899-12-31", "", "yesterday"])(
    "rejects the date of birth %j",
    (dateOfBirth) => {
      const result = signUpRequestSchema.safeParse({ ...base, dateOfBirth });
      expect(result.success).toBe(false);
      expect(fieldErrors(result)).toContain("dateOfBirth");
    },
  );

  it("normalises the guardian email and rejects the member's own address", () => {
    expect(
      signUpRequestSchema.parse({
        ...base,
        dateOfBirth: "2012-05-01",
        guardianEmail: " Mum@Example.com ",
      }).guardianEmail,
    ).toBe("mum@example.com");
    const same = signUpRequestSchema.safeParse({
      ...base,
      dateOfBirth: "2012-05-01",
      guardianEmail: "KID@example.com",
    });
    expect(same.success).toBe(false);
    expect(fieldErrors(same)).toEqual(["guardianEmail"]);
  });
});

describe("signUpRequestSchemaOn(today)", () => {
  const schema = signUpRequestSchemaOn(TODAY);

  it("accepts an adult without a guardian email", () => {
    expect(schema.safeParse({ ...base, dateOfBirth: "2008-11-24" }).success).toBe(true);
  });

  it("requires a guardian email the day before the 18th birthday", () => {
    const result = schema.safeParse({ ...base, dateOfBirth: "2008-11-25" });
    expect(result.success).toBe(false);
    expect(fieldErrors(result)).toEqual(["guardianEmail"]);
    expect(
      schema.safeParse({ ...base, dateOfBirth: "2008-11-25", guardianEmail: "mum@example.com" })
        .success,
    ).toBe(true);
  });

  it("rejects a date of birth in the future", () => {
    const result = schema.safeParse({
      ...base,
      dateOfBirth: "2026-11-25",
      guardianEmail: "mum@example.com",
    });
    expect(result.success).toBe(false);
    expect(fieldErrors(result)).toEqual(["dateOfBirth"]);
  });
});

describe("consent schemas", () => {
  it("consent request takes an optional guardian email", () => {
    expect(consentRequestRequestSchema.parse({})).toEqual({});
    expect(consentRequestRequestSchema.parse({ guardianEmail: "Dad@Example.com" })).toEqual({
      guardianEmail: "dad@example.com",
    });
    expect(consentRequestRequestSchema.safeParse({ guardianEmail: "nope" }).success).toBe(false);
  });

  it("confirm needs isParentOrGuardian: true; decline does not", () => {
    expect(
      consentDecisionRequestSchema.safeParse({
        token: "t",
        decision: "confirm",
        isParentOrGuardian: true,
      }).success,
    ).toBe(true);
    expect(
      consentDecisionRequestSchema.safeParse({ token: "t", decision: "confirm" }).success,
    ).toBe(false);
    expect(
      consentDecisionRequestSchema.safeParse({
        token: "t",
        decision: "confirm",
        isParentOrGuardian: false,
      }).success,
    ).toBe(false);
    expect(
      consentDecisionRequestSchema.safeParse({ token: "t", decision: "decline" }).success,
    ).toBe(true);
    expect(consentDecisionRequestSchema.safeParse({ token: "t", decision: "maybe" }).success).toBe(
      false,
    );
  });

  it("status response lists every state", () => {
    for (const state of CONSENT_STATES) {
      expect(
        consentStatusResponseSchema.safeParse({
          state,
          guardianEmail: null,
          requestedAt: null,
          expiresAt: null,
          decidedAt: null,
        }).success,
      ).toBe(true);
    }
  });

  it("the safeguarding text is a marked placeholder", () => {
    expect(SAFEGUARDING_POLICY_PLACEHOLDER).toMatch(/^\[PLACEHOLDER:/);
  });
});
