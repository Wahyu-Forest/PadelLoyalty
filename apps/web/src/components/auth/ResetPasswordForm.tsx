"use client";

import { newPasswordSchema, PASSWORD_MIN_LENGTH } from "@padelloyalty/shared";
import Link from "next/link";
import { useState } from "react";
import { errorMessage } from "@/lib/auth/api";
import { useAuth } from "./AuthProvider";
import { clearHash, Field, FormError, Notice, useHashToken } from "./Form";

export function ResetPasswordForm() {
  const { api, session, state } = useAuth();
  const token = useHashToken();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!token) return;
    setError(null);
    const parsed = newPasswordSchema.safeParse(password);
    const errors: Record<string, string[]> = {};
    if (!parsed.success) errors.password = parsed.error.issues.map((i) => i.message);
    if (password !== confirm) errors.confirm = ["The passwords don't match"];
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setSubmitting(true);
    const result = await api.confirmPasswordReset({ token, password });
    setSubmitting(false);
    if (!result.ok) {
      setFieldErrors(result.error.fieldErrors ?? {});
      setError(errorMessage(result.error));
      return;
    }
    clearHash();
    // The API logged the account out everywhere; forget any session here too.
    if (state.status === "authenticated") await session.logOut();
    setDone(result.data.message);
  }

  if (done) {
    return (
      <section className="card" data-testid="reset-done">
        <Notice>{done}</Notice>
        <p className="links">
          <Link href="/login/">Log in</Link>
        </p>
      </section>
    );
  }

  if (token === null) {
    return (
      <section className="card">
        <FormError message="This reset link is incomplete. Open the link from your email again, or ask for a new one." />
        <p className="links">
          <Link href="/forgot-password/">Get a new reset link</Link>
        </p>
      </section>
    );
  }

  return (
    <form className="card form" onSubmit={onSubmit} noValidate aria-label="Reset password">
      <FormError message={error} />
      {error ? (
        <p className="links">
          <Link href="/forgot-password/">Get a new reset link</Link>
        </p>
      ) : null}
      <Field
        label="New password"
        type="password"
        name="password"
        autoComplete="new-password"
        hint={`At least ${PASSWORD_MIN_LENGTH} characters.`}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        errors={fieldErrors.password}
        minLength={PASSWORD_MIN_LENGTH}
        required
      />
      <Field
        label="Repeat new password"
        type="password"
        name="confirm"
        autoComplete="new-password"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        errors={fieldErrors.confirm}
        required
      />
      <button type="submit" disabled={submitting || token === undefined}>
        {submitting ? "Saving…" : "Set new password"}
      </button>
    </form>
  );
}
