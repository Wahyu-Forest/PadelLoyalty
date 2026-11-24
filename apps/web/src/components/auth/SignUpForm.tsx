"use client";

import { PASSWORD_MIN_LENGTH, POINTS_NAME, signUpRequestSchema } from "@padelloyalty/shared";
import Link from "next/link";
import { useState } from "react";
import { errorMessage } from "@/lib/auth/api";
import { useAuth } from "./AuthProvider";
import { Field, fieldErrorsFrom, FormError, Notice } from "./Form";
import { ResendVerification } from "./ResendVerification";

export function SignUpForm() {
  const { api } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [sentTo, setSentTo] = useState<{ email: string; message: string } | null>(null);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    const parsed = signUpRequestSchema.safeParse({ email, password });
    if (!parsed.success) {
      setFieldErrors(fieldErrorsFrom(parsed.error.issues));
      return;
    }
    setFieldErrors({});
    setSubmitting(true);
    const result = await api.signUp(parsed.data);
    setSubmitting(false);
    if (!result.ok) {
      setFieldErrors(result.error.fieldErrors ?? {});
      setError(errorMessage(result.error));
      return;
    }
    setPassword("");
    setSentTo({ email: parsed.data.email, message: result.data.message });
  }

  if (sentTo) {
    return (
      <section className="card" data-testid="signup-done">
        <h2>Check your email</h2>
        <Notice>{sentTo.message}</Notice>
        <p>
          We sent it to <strong>{sentTo.email}</strong>. The link is valid for 24 hours.
        </p>
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
