"use client";

import { POINTS_NAME } from "@padelloyalty/shared";
import Link from "next/link";
import { isAccountFullyActive } from "@padelloyalty/shared";
import { useState } from "react";
import { PointsBalance } from "../points/PointsBalance";
import { useAuth } from "./AuthProvider";
import { ConsentPending, GuardianAfterVerification } from "./ConsentPending";
import { Notice } from "./Form";
import { ResendVerification } from "./ResendVerification";

/**
 * The member home's account panel: logged-in state with log out, or links to
 * log in / sign up. Fully active members also get their points balance (#6).
 */
export function MemberAccount() {
  const { session, state } = useAuth();
  const [loggingOut, setLoggingOut] = useState(false);

  if (state.status === "loading") {
    return (
      <section className="card" data-testid="account" aria-busy="true">
        <p>Loading your account…</p>
      </section>
    );
  }

  if (state.status === "unavailable") {
    return (
      <section className="card" data-testid="account">
        <Notice tone="warn">{state.error.message}</Notice>
        <button type="button" className="secondary" onClick={() => void session.start()}>
          Try again
        </button>
      </section>
    );
  }

  if (state.status === "anonymous") {
    return (
      <section className="card" data-testid="account">
        <p>Log in to see your bookings and {POINTS_NAME}.</p>
        <div className="actions">
          <Link className="button" href="/login/">
            Log in
          </Link>
          <Link className="button secondary" href="/signup/">
            Sign up
          </Link>
        </div>
      </section>
    );
  }

  const { user } = state;
  const active = isAccountFullyActive(user.status);
  return (
    <>
      {/* Only fully active accounts have a balance; pending ones see why below (#3, #6). */}
      {active ? <PointsBalance userId={user.id} /> : null}
      <section className="card" data-testid="account">
        <p>
          Logged in as <strong data-testid="account-email">{user.email}</strong>
        </p>
        {user.status === "pending_verification" ? (
          <Notice tone="warn" testId="verify-reminder">
            <p>
              Verify your email to activate your account. We sent a link to {user.email}; it&apos;s
              valid for 24 hours.
            </p>
            <GuardianAfterVerification user={user} />
            <ResendVerification email={user.email} />
          </Notice>
        ) : user.status === "pending_consent" ? (
          <ConsentPending user={user} />
        ) : (
          <p>Your bookings will appear here.</p>
        )}
        <button
          type="button"
          className="secondary"
          disabled={loggingOut}
          onClick={async () => {
            setLoggingOut(true);
            await session.logOut();
            setLoggingOut(false);
          }}
        >
          {loggingOut ? "Logging out…" : "Log out"}
        </button>
      </section>
    </>
  );
}
