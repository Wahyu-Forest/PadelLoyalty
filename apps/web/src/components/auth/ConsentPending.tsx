"use client";

import {
  ADULT_AGE,
  POINTS_NAME,
  consentRequestRequestSchema,
  type AuthUser,
  type ConsentStatusResponse,
} from "@padelloyalty/shared";
import { useCallback, useEffect, useState } from "react";
import { errorMessage, type ApiResult } from "@/lib/auth/api";
import { useAuth } from "./AuthProvider";
import { Field, fieldErrorsFrom, FormError, Notice } from "./Form";

function formatDate(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

/** Loads the member's consent status (GET /auth/consent) with the session's access token. */
function useConsentStatus(user: AuthUser) {
  const { api, session } = useAuth();
  const [status, setStatus] = useState<ConsentStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    const token = await session.getAccessToken();
    return token ? api.consentStatus(token) : null;
  }, [api, session]);

  const apply = useCallback(
    async (result: ApiResult<ConsentStatusResponse> | null) => {
      if (!result) return;
      if (result.ok) {
        setStatus(result.data);
        setError(null);
        // A guardian confirmed meanwhile (e.g. on another device): show the active account.
        if (result.data.state === "granted") await session.reloadUser();
      } else {
        setError(errorMessage(result.error));
      }
    },
    [session],
  );

  const load = useCallback(async () => apply(await fetchStatus()), [apply, fetchStatus]);

  useEffect(() => {
    let active = true;
    void fetchStatus().then((result) => {
      if (active) void apply(result);
    });
    return () => {
      active = false;
    };
  }, [apply, fetchStatus, user.status]);

  return { status, setStatus, error, reload: load };
}

/** "We'll ask your guardian once you've verified" line for an unverified under-18 member. */
export function GuardianAfterVerification({ user }: { user: AuthUser }) {
  const { status } = useConsentStatus(user);
  if (status?.state !== "awaiting_member_verification") return null;
  return (
    <p data-testid="guardian-after-verification">
      Once your email is verified, we&apos;ll ask <strong>{status.guardianEmail}</strong> for their
      consent.
    </p>
  );
}

/**
 * The member home for a `pending_consent` account (#3): why the account is
 * pending, where the request stands, resend, and change guardian.
 */
export function ConsentPending({ user }: { user: AuthUser }) {
  const { api, session } = useAuth();
  const { status, setStatus, error: loadError, reload } = useConsentStatus(user);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);
  const [newGuardian, setNewGuardian] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  async function send(body: { guardianEmail?: string }): Promise<boolean> {
    setBusy(true);
    setError(null);
    setMessage(null);
    const token = await session.getAccessToken();
    const result: ApiResult<ConsentStatusResponse> | null = token
      ? await api.requestConsent(token, body)
      : null;
    setBusy(false);
    if (!result) return false;
    if (!result.ok) {
      setFieldErrors(result.error.fieldErrors ?? {});
      setError(errorMessage(result.error));
      return false;
    }
    setFieldErrors({});
    setStatus(result.data);
    setMessage(`We've emailed ${result.data.guardianEmail} a new link.`);
    return true;
  }

  async function onChangeGuardian(event: React.FormEvent) {
    event.preventDefault();
    const parsed = consentRequestRequestSchema.safeParse({ guardianEmail: newGuardian });
    if (!parsed.success || !parsed.data.guardianEmail) {
      setFieldErrors(
        parsed.success
          ? { guardianEmail: ["Enter your parent or guardian's email"] }
          : fieldErrorsFrom(parsed.error.issues),
      );
      return;
    }
    if (parsed.data.guardianEmail === user.email) {
      setFieldErrors({
        guardianEmail: ["Your parent or guardian's email must be different from yours"],
      });
      return;
    }
    if (await send({ guardianEmail: parsed.data.guardianEmail })) {
      setChanging(false);
      setNewGuardian("");
    }
  }

  const state = status?.state;
  const declined = state === "declined";
  const showChangeForm = changing || declined;

  return (
    <Notice tone="warn" testId="consent-pending">
      <h2>Waiting for your parent or guardian</h2>
      <p>
        Because you&apos;re under {ADULT_AGE}, a parent or guardian needs to give their consent
        before you can book courts or collect {POINTS_NAME}.
      </p>
      {!status && !loadError ? <p>Loading…</p> : null}
      <FormError message={loadError} />
      {state === "pending" ? (
        <p data-testid="consent-state" data-state="pending">
          We emailed <strong>{status?.guardianEmail}</strong> on{" "}
          {formatDate(status?.requestedAt ?? null)}. Their link works until{" "}
          {formatDate(status?.expiresAt ?? null)}.
        </p>
      ) : null}
      {state === "expired" ? (
        <p data-testid="consent-state" data-state="expired">
          The link we sent to <strong>{status?.guardianEmail}</strong> has expired. Send them a new
          one.
        </p>
      ) : null}
      {state === "not_sent" ? (
        <p data-testid="consent-state" data-state="not_sent">
          We haven&apos;t emailed <strong>{status?.guardianEmail}</strong> yet. Send the request
          now.
        </p>
      ) : null}
      {declined ? (
        <p data-testid="consent-state" data-state="declined">
          <strong>{status?.guardianEmail}</strong> declined. You can ask a different parent or
          guardian.
        </p>
      ) : null}

      {message ? <Notice testId="consent-message">{message}</Notice> : null}
      <FormError message={error} />

      {status && !declined ? (
        <div className="actions">
          <button type="button" className="secondary" disabled={busy} onClick={() => send({})}>
            {busy ? "Sending…" : "Resend request"}
          </button>
          {!changing ? (
            <button type="button" className="secondary" onClick={() => setChanging(true)}>
              Use a different email
            </button>
          ) : null}
        </div>
      ) : null}

      {status && showChangeForm ? (
        <form
          className="form"
          onSubmit={onChangeGuardian}
          noValidate
          aria-label="Change parent or guardian"
        >
          <Field
            label="Parent or guardian's email"
            type="email"
            name="guardianEmail"
            autoComplete="off"
            inputMode="email"
            value={newGuardian}
            onChange={(e) => setNewGuardian(e.target.value)}
            errors={fieldErrors.guardianEmail}
            required
          />
          <div className="actions">
            <button type="submit" disabled={busy}>
              {busy ? "Sending…" : "Send request"}
            </button>
            {changing && !declined ? (
              <button type="button" className="secondary" onClick={() => setChanging(false)}>
                Cancel
              </button>
            ) : null}
          </div>
        </form>
      ) : null}

      {status ? (
        <p className="links">
          <button type="button" className="link" onClick={() => void reload()}>
            Already confirmed? Check again
          </button>
        </p>
      ) : null}
    </Notice>
  );
}
