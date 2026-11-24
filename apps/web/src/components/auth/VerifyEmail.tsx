"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  errorMessage,
  type ApiResult,
  type AuthApi,
  type VerifyEmailResponse,
} from "@/lib/auth/api";
import { useAuth } from "./AuthProvider";
import { clearHash, FormError, Notice, useHashToken } from "./Form";

type State =
  { kind: "verifying" } | { kind: "done"; message: string } | { kind: "failed"; message: string };

// A link token works once: never send it twice, even if the effect runs twice
// (React strict mode in development).
const attempts = new Map<string, Promise<ApiResult<VerifyEmailResponse>>>();
function verifyOnce(api: AuthApi, token: string) {
  let attempt = attempts.get(token);
  if (!attempt) {
    attempt = api.verifyEmail(token);
    attempts.set(token, attempt);
  }
  return attempt;
}

export function VerifyEmail() {
  const { api, session, state: auth } = useAuth();
  const token = useHashToken();
  const [result, setState] = useState<State>({ kind: "verifying" });

  useEffect(() => {
    if (!token) return;
    let active = true;
    void verifyOnce(api, token).then(async (result) => {
      clearHash();
      if (!active) return;
      if (result.ok) {
        setState({ kind: "done", message: result.data.message });
        // If this browser is logged in, show the account as verified at once.
        await session.reloadUser();
      } else {
        setState({ kind: "failed", message: errorMessage(result.error) });
      }
    });
    return () => {
      active = false;
    };
  }, [api, session, token]);

  // Once a result is in, it wins: the token has been removed from the URL by then.
  const state: State | { kind: "missing" } =
    result.kind === "verifying" && token === null ? { kind: "missing" } : result;

  const loggedIn = auth.status === "authenticated";
  return (
    <section className="card" data-testid="verify-email" aria-live="polite">
      {state.kind === "verifying" ? <p>Verifying your email…</p> : null}
      {state.kind === "done" ? (
        <>
          <Notice testId="verify-success">{state.message} Your account is active.</Notice>
          <p className="links">
            {loggedIn ? <Link href="/">Go to home</Link> : <Link href="/login/">Log in</Link>}
          </p>
        </>
      ) : null}
      {state.kind === "failed" || state.kind === "missing" ? (
        <>
          <FormError
            message={
              state.kind === "failed"
                ? state.message
                : "This verification link is incomplete. Open the link from your email again."
            }
          />
          <p>
            You can ask for a new link from the home page after logging in, or by signing up again
            with the same email.
          </p>
          <p className="links">
            <Link href="/login/">Log in</Link>
          </p>
        </>
      ) : null}
    </section>
  );
}
