"use client";

import {
  canAccessBackOffice,
  canSetUpClubs,
  isAccountFullyActive,
  type AuthUser,
} from "@padelloyalty/shared";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "../auth/AuthProvider";
import { Notice } from "../auth/Form";

const ROLE_LABELS: Record<AuthUser["role"], string> = {
  member: "member",
  receptionist: "receptionist",
  club_manager: "club manager",
  admin: "admin",
};

/**
 * Shows `children` only to staff (or only to admins with `require="admin"`).
 * A convenience for the static web app: the API enforces the same rules
 * (docs/api/clubs.md), so hiding screens here is not the protection.
 */
export function BackOfficeGate({
  require = "staff",
  children,
}: {
  require?: "staff" | "admin";
  children: (user: AuthUser) => React.ReactNode;
}) {
  const { session, state } = useAuth();
  const pathname = usePathname();

  if (state.status === "loading") {
    return (
      <section className="card" aria-busy="true" data-testid="gate-loading">
        <p>Checking your access…</p>
      </section>
    );
  }

  if (state.status === "unavailable") {
    return (
      <section className="card">
        <Notice tone="warn">{state.error.message}</Notice>
        <div className="actions">
          <button type="button" className="secondary" onClick={() => void session.start()}>
            Try again
          </button>
        </div>
      </section>
    );
  }

  if (state.status === "anonymous") {
    // Only rendered in the browser (the first render is "loading"), so reading the URL is safe.
    const next = `${pathname}${window.location.search}`;
    return (
      <section className="card" data-testid="gate-login">
        <p>Log in with your staff account to use the back office.</p>
        <div className="actions">
          <Link className="button" href={`/login/?next=${encodeURIComponent(next)}`}>
            Log in
          </Link>
        </div>
      </section>
    );
  }

  const { user } = state;
  const allowed = require === "admin" ? canSetUpClubs(user.role) : canAccessBackOffice(user.role);
  if (!allowed) {
    return (
      <section className="card" data-testid="no-access">
        <Notice tone="warn">
          <h2>No access</h2>
          <p>
            {require === "admin" && canAccessBackOffice(user.role)
              ? "Club setup is for admins only."
              : "The back office is for Soul Padel staff only."}{" "}
            You&apos;re logged in as {user.email} ({ROLE_LABELS[user.role]}).
          </p>
        </Notice>
        <p className="links">
          <Link href={canAccessBackOffice(user.role) ? "/admin/" : "/"}>
            {canAccessBackOffice(user.role) ? "Back office home" : "Go to the member app"}
          </Link>
        </p>
      </section>
    );
  }

  if (!isAccountFullyActive(user.status)) {
    return (
      <section className="card" data-testid="no-access">
        <Notice tone="warn">
          <h2>Account not active</h2>
          <p>
            Verify your email before using the back office. You&apos;re logged in as {user.email}.
          </p>
        </Notice>
      </section>
    );
  }

  return <>{children(user)}</>;
}

export { ROLE_LABELS };
