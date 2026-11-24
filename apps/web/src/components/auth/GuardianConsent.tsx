"use client";

import {
  POINTS_NAME,
  SAFEGUARDING_POLICY_PLACEHOLDER,
  ageOn,
  calendarDateLocal,
  type ConsentDecision,
} from "@padelloyalty/shared";
import { useEffect, useId, useState } from "react";
import {
  errorMessage,
  type ApiResult,
  type AuthApi,
  type ConsentReviewResponse,
} from "@/lib/auth/api";
import { useAuth } from "./AuthProvider";
import { clearHash, FormError, Notice, useHashToken } from "./Form";

type State =
  | { kind: "loading" }
  | { kind: "review"; details: ConsentReviewResponse }
  | { kind: "failed"; message: string }
  | { kind: "done"; decision: ConsentDecision; message: string };

// Review does not use up the link, but there is no point asking twice for one
// token (React strict mode runs effects twice in development).
const reviews = new Map<string, Promise<ApiResult<ConsentReviewResponse>>>();
function reviewOnce(api: AuthApi, token: string) {
  let review = reviews.get(token);
  if (!review) {
    review = api.reviewConsent(token);
    reviews.set(token, review);
  }
  return review;
}

function formatDateOfBirth(dateOfBirth: string): string {
  const [year, month, day] = dateOfBirth.split("-").map(Number);
  const formatted = new Date(year ?? 0, (month ?? 1) - 1, day ?? 1).toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  try {
    return `${formatted} (age ${ageOn(dateOfBirth, calendarDateLocal(new Date()))})`;
  } catch {
    return formatted;
  }
}

/**
 * The page a guardian opens from the consent email (#3): shows who is asking,
 * then records their decision. The token stays in the URL fragment (never
 * sent to the web host) until the decision is made, so a reload still works.
 */
export function GuardianConsent() {
  const { api } = useAuth();
  const token = useHashToken();
  const checkboxId = useId();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [isGuardian, setIsGuardian] = useState(false);
  const [checkboxError, setCheckboxError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<ConsentDecision | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    let active = true;
    void reviewOnce(api, token).then((result) => {
      if (!active) return;
      if (result.ok) setState({ kind: "review", details: result.data });
      else setState({ kind: "failed", message: errorMessage(result.error) });
    });
    return () => {
      active = false;
    };
  }, [api, token]);

  async function decide(decision: ConsentDecision) {
    if (!token) return;
    setError(null);
    if (decision === "confirm" && !isGuardian) {
      setCheckboxError("Confirm that you are this member's parent or legal guardian.");
      return;
    }
    setCheckboxError(null);
    setSubmitting(decision);
    const result = await api.decideConsent(
      decision === "confirm"
        ? { token, decision, isParentOrGuardian: true }
        : { token, decision: "decline" },
    );
    setSubmitting(null);
    if (result.ok) {
      clearHash();
      setState({ kind: "done", decision: result.data.decision, message: result.data.message });
    } else if (result.error.code === "invalid_token") {
      clearHash();
      setState({ kind: "failed", message: errorMessage(result.error) });
    } else {
      setError(errorMessage(result.error));
    }
  }

  const view: State | { kind: "missing" } =
    state.kind === "loading" && token === null ? { kind: "missing" } : state;

  return (
    <section className="card" data-testid="guardian-consent" aria-live="polite">
      {view.kind === "loading" ? <p>Loading the request…</p> : null}

      {view.kind === "missing" || view.kind === "failed" ? (
        <>
          <FormError
            message={
              view.kind === "failed"
                ? view.message
                : "This consent link is incomplete. Open the link from the email again."
            }
          />
          <p>
            If you still need to respond, ask the member to send a new request from their Soul Padel
            account.
          </p>
        </>
      ) : null}

      {view.kind === "done" ? (
        <Notice testId="consent-done" tone={view.decision === "confirm" ? "ok" : "info"}>
          {view.message}
        </Notice>
      ) : null}

      {view.kind === "review" ? (
        <>
          <p>
            <strong>{view.details.memberEmail}</strong> has signed up for Soul Padel and told us
            they are under 18. They gave your email address as their parent or guardian.
          </p>
          <dl className="details" data-testid="consent-details">
            <dt>Member</dt>
            <dd>{view.details.memberEmail}</dd>
            <dt>Date of birth</dt>
            <dd>{formatDateOfBirth(view.details.memberDateOfBirth)}</dd>
            <dt>Your email</dt>
            <dd>{view.details.guardianEmail}</dd>
          </dl>
          <p>
            If you give consent, they can use the Soul Padel app: book courts and collect{" "}
            {POINTS_NAME}. If you decline, the account stays inactive. If you don&apos;t know this
            person, decline.
          </p>
          <p className="placeholder" data-testid="safeguarding-placeholder">
            {SAFEGUARDING_POLICY_PLACEHOLDER}
          </p>
          <div className="field">
            <label className="checkbox" htmlFor={checkboxId}>
              <input
                id={checkboxId}
                type="checkbox"
                checked={isGuardian}
                aria-invalid={checkboxError ? true : undefined}
                onChange={(e) => {
                  setIsGuardian(e.target.checked);
                  if (e.target.checked) setCheckboxError(null);
                }}
              />
              I am this member&apos;s parent or legal guardian
            </label>
            {checkboxError ? <p className="field-error">{checkboxError}</p> : null}
          </div>
          <FormError message={error} />
          <div className="actions">
            <button type="button" disabled={submitting !== null} onClick={() => decide("confirm")}>
              {submitting === "confirm" ? "Saving…" : "Give consent"}
            </button>
            <button
              type="button"
              className="secondary"
              disabled={submitting !== null}
              onClick={() => decide("decline")}
            >
              {submitting === "decline" ? "Saving…" : "Decline"}
            </button>
          </div>
        </>
      ) : null}
    </section>
  );
}
