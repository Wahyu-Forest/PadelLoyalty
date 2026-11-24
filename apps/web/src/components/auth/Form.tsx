"use client";

import { useId, useSyncExternalStore } from "react";

interface FieldProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "id"> {
  label: string;
  hint?: string;
  errors?: string[] | undefined;
}

/** Labelled input with an optional hint and field errors, wired up for screen readers. */
export function Field({ label, hint, errors, ...input }: FieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const hasError = !!errors && errors.length > 0;
  const describedBy = [hint ? hintId : null, hasError ? errorId : null].filter(Boolean).join(" ");
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        aria-invalid={hasError || undefined}
        aria-describedby={describedBy || undefined}
        {...input}
      />
      {hint ? (
        <p id={hintId} className="hint">
          {hint}
        </p>
      ) : null}
      {hasError ? (
        <p id={errorId} className="field-error">
          {errors.join(" ")}
        </p>
      ) : null}
    </div>
  );
}

export function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p className="alert" role="alert" data-tone="error" data-testid="form-error">
      {message}
    </p>
  );
}

export function Notice({
  children,
  tone = "ok",
  testId,
}: {
  children: React.ReactNode;
  tone?: "ok" | "warn" | "info";
  testId?: string;
}) {
  return (
    <div className="alert" role="status" data-tone={tone} data-testid={testId}>
      {children}
    </div>
  );
}

/** Field errors from a Zod `safeParse` failure, keyed by field name. */
export function fieldErrorsFrom(issues: { path: PropertyKey[]; message: string }[]) {
  const errors: Record<string, string[]> = {};
  for (const issue of issues) {
    const key = String(issue.path[0] ?? "_");
    (errors[key] ??= []).push(issue.message);
  }
  return errors;
}

/** Reads `#token=…` from the URL fragment (never sent to the web host). */
export function readTokenFromHash(): string | null {
  return new URLSearchParams(window.location.hash.replace(/^#/, "")).get("token");
}

/** Removes the token from the address bar and history once it has been used. */
export function clearHash(): void {
  if (window.location.hash) {
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
  }
}

function subscribeToHash(onChange: () => void) {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

/**
 * The `#token=` of the current URL: `undefined` while pre-rendering (no URL
 * yet), then the token or null.
 */
export function useHashToken(): string | null | undefined {
  return useSyncExternalStore(subscribeToHash, readTokenFromHash, () => undefined);
}
