import { z } from "zod";
import { emailSchema } from "./auth.js";

/**
 * Guardian consent API contract (issue #3). Human-readable version:
 * docs/api/consent.md.
 *
 * An under-18 member nominates a parent or guardian at sign-up. Once the
 * member has verified their own email, the guardian is emailed a single-use,
 * expiring link; on the consent page they confirm or decline. Until someone
 * confirms, the account is `pending_consent`.
 */

/** How long a guardian consent link stays valid. */
export const GUARDIAN_CONSENT_LINK_DAYS = 7;

/**
 * PLACEHOLDER, not policy. Soul Padel's Safeguarding Policy has not been
 * supplied yet. Shown on the guardian consent page and in the consent email
 * where the policy should be linked or summarised. Replace this (and remove
 * the placeholder marker) once the policy is available; see the #3 PR.
 */
export const SAFEGUARDING_POLICY_PLACEHOLDER =
  "[PLACEHOLDER: Soul Padel Safeguarding Policy summary and link go here. To be supplied by Soul Padel before launch.]";

// ---------------------------------------------------------------------------
// The member's view: GET /auth/consent, POST /auth/consent/request
// ---------------------------------------------------------------------------

/**
 * Where the member's guardian consent stands.
 *
 * - `not_required`: adult (or an account from before #3 with no date of birth).
 * - `awaiting_member_verification`: under 18, own email not verified yet; the
 *   guardian is emailed once it is.
 * - `not_sent`: under 18, verified, but no request has been emailed (e.g. it
 *   was rate limited). The member can send one.
 * - `pending`: a link was emailed and is still valid.
 * - `expired`: the latest link expired unused. The member can resend.
 * - `declined`: the guardian declined. The member can nominate a different guardian.
 * - `granted`: a guardian confirmed; the account is active.
 */
export const CONSENT_STATES = [
  "not_required",
  "awaiting_member_verification",
  "not_sent",
  "pending",
  "expired",
  "declined",
  "granted",
] as const;
export const consentStateSchema = z.enum(CONSENT_STATES);
export type ConsentState = z.infer<typeof consentStateSchema>;

/** 200 from GET /auth/consent and POST /auth/consent/request. */
export const consentStatusResponseSchema = z.object({
  state: consentStateSchema,
  /** The nominated guardian's email; null when consent is not required. */
  guardianEmail: z.string().nullable(),
  /** When the latest consent email was sent. */
  requestedAt: z.iso.datetime().nullable(),
  /** When the latest consent link expires (or expired). */
  expiresAt: z.iso.datetime().nullable(),
  /** When the guardian confirmed or declined the latest request. */
  decidedAt: z.iso.datetime().nullable(),
});
export type ConsentStatusResponse = z.infer<typeof consentStatusResponseSchema>;

/**
 * POST /auth/consent/request (Bearer). Without `guardianEmail`: resend to the
 * current guardian (a new link; older links stop working). With it: switch to
 * that guardian (must differ from the member's own email) and email them.
 */
export const consentRequestRequestSchema = z.object({
  guardianEmail: emailSchema.optional(),
});
export type ConsentRequestRequest = z.infer<typeof consentRequestRequestSchema>;

// ---------------------------------------------------------------------------
// The guardian's view: POST /auth/consent/review, POST /auth/consent/decision
// ---------------------------------------------------------------------------

const consentTokenSchema = z
  .string({ error: "Token is required" })
  .min(1, { error: "Token is required" })
  .max(512, { error: "Token is too long" });

/** POST /auth/consent/review: what the guardian is asked to consent to. Does not use up the link. */
export const consentReviewRequestSchema = z.object({ token: consentTokenSchema });
export type ConsentReviewRequest = z.infer<typeof consentReviewRequestSchema>;

/** 200 from POST /auth/consent/review. */
export const consentReviewResponseSchema = z.object({
  memberEmail: z.string(),
  /** `YYYY-MM-DD`, so the guardian can check it is the right child. */
  memberDateOfBirth: z.string(),
  guardianEmail: z.string(),
  expiresAt: z.iso.datetime(),
});
export type ConsentReviewResponse = z.infer<typeof consentReviewResponseSchema>;

export const CONSENT_DECISIONS = ["confirm", "decline"] as const;
export const consentDecisionSchema = z.enum(CONSENT_DECISIONS);
export type ConsentDecision = z.infer<typeof consentDecisionSchema>;

/**
 * POST /auth/consent/decision. Uses up the link. To confirm, the guardian
 * must also state they are the member's parent or legal guardian
 * (`isParentOrGuardian: true`), which is recorded with the consent.
 */
export const consentDecisionRequestSchema = z.discriminatedUnion("decision", [
  z.object({
    token: consentTokenSchema,
    decision: z.literal("confirm"),
    isParentOrGuardian: z.literal(true, {
      error: "Confirm that you are this member's parent or legal guardian",
    }),
  }),
  z.object({
    token: consentTokenSchema,
    decision: z.literal("decline"),
  }),
]);
export type ConsentDecisionRequest = z.infer<typeof consentDecisionRequestSchema>;

/** 200 from POST /auth/consent/decision. */
export const consentDecisionResponseSchema = z.object({
  message: z.string(),
  decision: consentDecisionSchema,
});
export type ConsentDecisionResponse = z.infer<typeof consentDecisionResponseSchema>;
