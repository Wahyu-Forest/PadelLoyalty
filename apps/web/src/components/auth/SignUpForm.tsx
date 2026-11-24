"use client";

import {
  ADULT_AGE,
  EARLIEST_DATE_OF_BIRTH,
  PASSWORD_MIN_LENGTH,
  POINTS_NAME,
  calendarDateLocal,
  isValidCalendarDate,
  needsGuardianConsent,
  signUpRequestSchemaOn,
} from "@padelloyalty/shared";
import Link from "next/link";
import { useState, useSyncExternalStore } from "react";
import { errorMessage } from "@/lib/auth/api";
import { useAuth } from "./AuthProvider";
import { Field, fieldErrorsFrom, FormError, Notice } from "./Form";
import { ResendVerification } from "./ResendVerification";

const noSubscription = () => () => {};

/**
 * Today's date on this device, `YYYY-MM-DD`; null while pre-rendering, so the
 * static HTML does not bake in the build date.
 */
function useToday(): string | null {
  return useSyncExternalStore(
    noSubscription,
    () => calendarDateLocal(new Date()),
    () => null,
  );
}

/** True once a complete, real, non-future date of birth under 18 has been entered. */
function isMinorOn(dateOfBirth: string, today: string): boolean {
  return (
    isValidCalendarDate(dateOfBirth) &&
    dateOfBirth <= today &&
    needsGuardianConsent(dateOfBirth, today)
  );
}

export function SignUpForm() {
  const { api } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [dateOfBirth, setDateOfBirth] = useState("");
  const [guardianEmail, setGuardianEmail] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [sentTo, setSentTo] = useState<{
    email: string;
    message: string;
    guardianEmail?: string;
  } | null>(null);

  // The device's date. The API checks again with its own (UTC) date.
  const today = useToday();
  // The API may still ask for a guardian (its date can differ around midnight).
  const [apiWantsGuardian, setApiWantsGuardian] = useState(false);
  const minor = (today !== null && isMinorOn(dateOfBirth, today)) || apiWantsGuardian;

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    const parsed = signUpRequestSchemaOn(today ?? calendarDateLocal(new Date())).safeParse({
      email,
      password,
      dateOfBirth,
      // Left empty: omitted, so the message says a guardian is needed.
      ...(minor && guardianEmail.trim() !== "" ? { guardianEmail } : {}),
    });
    if (!parsed.success) {
      setFieldErrors(fieldErrorsFrom(parsed.error.issues));
      return;
    }
    setFieldErrors({});
    setSubmitting(true);
    const result = await api.signUp(parsed.data);
    setSubmitting(false);
    if (!result.ok) {
      if (result.error.fieldErrors?.guardianEmail) setApiWantsGuardian(true);
      setFieldErrors(result.error.fieldErrors ?? {});
      setError(errorMessage(result.error));
      return;
    }
    setPassword("");
    setSentTo({
      email: parsed.data.email,
      message: result.data.message,
      ...(parsed.data.guardianEmail ? { guardianEmail: parsed.data.guardianEmail } : {}),
    });
  }

  if (sentTo) {
    return (
      <section className="card" data-testid="signup-done">
        <h2>Check your email</h2>
        <Notice>{sentTo.message}</Notice>
        <p>
          We sent it to <strong>{sentTo.email}</strong>. The link is valid for 24 hours.
        </p>
        {sentTo.guardianEmail ? (
          <p data-testid="signup-guardian-next">
            Because you&apos;re under {ADULT_AGE}, once you&apos;ve verified your email we&apos;ll
            ask <strong>{sentTo.guardianEmail}</strong> to give their consent.
          </p>
        ) : null}
        <ResendVerification email={sentTo.email} />
        <p className="links">
          <Link href="/login/">Go to log in</Link>
        </p>
      </section>
    );
  }

  return (
    <form className="card form" onSubmit={onSubmit} noValidate aria-label="Sign up">
      <p>Create your account to book courts and collect {POINTS_NAME}.</p>
      <FormError message={error} />
      <Field
        label="Email"
        type="email"
        name="email"
        autoComplete="email"
        inputMode="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        errors={fieldErrors.email}
        required
      />
      <Field
        label="Password"
        type="password"
        name="password"
        autoComplete="new-password"
        hint={`At least ${PASSWORD_MIN_LENGTH} characters. A short phrase is easy to remember.`}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        errors={fieldErrors.password}
        minLength={PASSWORD_MIN_LENGTH}
        required
      />
      <Field
        label="Date of birth"
        type="date"
        name="dateOfBirth"
        autoComplete="bday"
        min={EARLIEST_DATE_OF_BIRTH}
        max={today ?? undefined}
        hint={`Members under ${ADULT_AGE} need a parent or guardian's consent.`}
        value={dateOfBirth}
        onChange={(e) => {
          setDateOfBirth(e.target.value);
          setApiWantsGuardian(false);
        }}
        errors={fieldErrors.dateOfBirth}
        required
      />
      {minor ? (
        <Field
          label="Parent or guardian's email"
          type="email"
          name="guardianEmail"
          autoComplete="off"
          inputMode="email"
          hint="We'll ask them to confirm you can use Soul Padel, after you verify your own email."
          value={guardianEmail}
          onChange={(e) => setGuardianEmail(e.target.value)}
          errors={fieldErrors.guardianEmail}
          required
        />
      ) : null}
      <button type="submit" disabled={submitting}>
        {submitting ? "Creating account…" : "Sign up"}
      </button>
      <p className="links">
        <span>
          Already have an account? <Link href="/login/">Log in</Link>
        </span>
      </p>
    </form>
  );
}
