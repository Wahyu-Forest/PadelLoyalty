"use client";

import { useId } from "react";

interface SelectFieldProps extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "id"> {
  label: string;
  hint?: string;
  errors?: string[] | undefined;
  options: readonly { value: string; label: string }[];
}

/** Labelled select, styled and wired like `Field`. */
export function SelectField({ label, hint, errors, options, ...select }: SelectFieldProps) {
  const id = useId();
  const hasError = !!errors && errors.length > 0;
  const describedBy = [hint ? `${id}-hint` : null, hasError ? `${id}-error` : null]
    .filter(Boolean)
    .join(" ");
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        aria-invalid={hasError || undefined}
        aria-describedby={describedBy || undefined}
        {...select}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {hint ? (
        <p id={`${id}-hint`} className="hint">
          {hint}
        </p>
      ) : null}
      {hasError ? (
        <p id={`${id}-error`} className="field-error">
          {errors.join(" ")}
        </p>
      ) : null}
    </div>
  );
}

/** Every message of a validation failure, for forms with nested fields. */
export function ErrorList({ messages, testId }: { messages: string[]; testId?: string }) {
  if (messages.length === 0) return null;
  return (
    <div className="alert" role="alert" data-tone="error" data-testid={testId ?? "form-error"}>
      {messages.length === 1 ? (
        <p>{messages[0]}</p>
      ) : (
        <ul>
          {messages.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Quarter-hour times `00:00`…`23:45` (and `24:00` with `includeEndOfDay`). */
export function quarterHourOptions(includeEndOfDay: boolean) {
  const options: { value: string; label: string }[] = [];
  const last = includeEndOfDay ? 24 * 4 : 24 * 4 - 1;
  for (let i = 0; i <= last; i++) {
    const value = `${String(Math.floor(i / 4)).padStart(2, "0")}:${String((i % 4) * 15).padStart(2, "0")}`;
    options.push({ value, label: value === "24:00" ? "24:00 (midnight)" : value });
  }
  return options;
}
