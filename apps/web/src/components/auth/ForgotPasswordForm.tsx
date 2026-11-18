"use client";

import { passwordResetRequestSchema } from "@padelloyalty/shared";
import Link from "next/link";
import { useState } from "react";
import { errorMessage } from "@/lib/auth/api";
import { useAuth } from "./AuthProvider";
import { Field, fieldErrorsFrom, FormError, Notice } from "./Form";

export function ForgotPasswordForm() {
  const { api } = useAuth();
  const [email, setEmail] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    const parsed = passwordResetRequestSchema.safeParse({ email });
    if (!parsed.success) {
      setFieldErrors(fieldErrorsFrom(parsed.error.issues));
      return;
    }
    setFieldErrors({});
    setSubmitting(true);
    const result = await api.requestPasswordReset(parsed.data.email);
    setSubmitting(false);
    if (result.ok) setMessage(result.data.message);
    else setError(errorMessage(result.error));
  }

  if (message) {
    return (
      <section className="card" data-testid="forgot-done">
        <Notice>{message}</Notice>
        <p>The link is valid for 1 hour. Check your spam folder if it doesn&apos;t arrive.</p>
        <p className="links">
          <Link href="/login/">Back to log in</Link>
        </p>
      </section>
    );
  }

  return (
    <form className="card form" onSubmit={onSubmit} noValidate aria-label="Forgot password">
      <p>
        Enter your account&apos;s email and we&apos;ll send you a link to choose a new password.
      </p>
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
      <button type="submit" disabled={submitting}>
        {submitting ? "Sending…" : "Send reset link"}
      </button>
      <p className="links">
        <Link href="/login/">Back to log in</Link>
      </p>
    </form>
  );
}
