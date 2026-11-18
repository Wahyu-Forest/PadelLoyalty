"use client";

import { useState } from "react";
import { errorMessage } from "@/lib/auth/api";
import { useAuth } from "./AuthProvider";
import { FormError, Notice } from "./Form";

/** "Didn't get the email?" button: asks for a new verification link. */
export function ResendVerification({ email }: { email: string }) {
  const { api } = useAuth();
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function resend() {
    setSending(true);
    setError(null);
    setMessage(null);
    const result = await api.resendVerification(email);
    setSending(false);
    if (result.ok) setMessage(result.data.message);
    else setError(errorMessage(result.error));
  }

  return (
    <div className="resend">
      <button type="button" className="secondary" onClick={resend} disabled={sending}>
        {sending ? "Sending…" : "Resend verification email"}
      </button>
      {message ? <Notice>{message}</Notice> : null}
      <FormError message={error} />
    </div>
  );
}
