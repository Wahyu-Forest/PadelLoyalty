"use client";

import { logInRequestSchema } from "@padelloyalty/shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { errorMessage } from "@/lib/auth/api";
import { safeNextPath } from "@/lib/safe-next";
import { useAuth } from "./AuthProvider";
import { Field, fieldErrorsFrom, FormError } from "./Form";

/** `?next=/admin/` brings staff back to the back office after logging in (#56). */
function destination(): string {
  return safeNextPath(new URLSearchParams(window.location.search).get("next")) ?? "/";
}

export function LogInForm() {
  const { session, state } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (state.status === "authenticated") router.replace(destination());
  }, [state.status, router]);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    const parsed = logInRequestSchema.safeParse({ email, password });
    if (!parsed.success) {
      setFieldErrors(fieldErrorsFrom(parsed.error.issues));
      return;
    }
    setFieldErrors({});
    setSubmitting(true);
    const result = await session.logIn(parsed.data);
    setSubmitting(false);
    if (!result.ok) {
      setFieldErrors(result.error.fieldErrors ?? {});
      setError(errorMessage(result.error));
      return;
    }
    router.replace(destination());
  }

  return (
    <form className="card form" onSubmit={onSubmit} noValidate aria-label="Log in">
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
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        errors={fieldErrors.password}
        required
      />
      <button type="submit" disabled={submitting}>
        {submitting ? "Logging in…" : "Log in"}
      </button>
      <p className="links">
        <Link href="/forgot-password/">Forgot your password?</Link>
        <Link href="/signup/">Create an account</Link>
      </p>
    </form>
  );
}
