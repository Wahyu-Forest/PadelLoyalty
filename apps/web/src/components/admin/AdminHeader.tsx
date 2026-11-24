"use client";

import Link from "next/link";
import { useAuth } from "../auth/AuthProvider";
import { ROLE_LABELS } from "./BackOfficeGate";

/** Who is logged in, with log out, for back office pages. */
export function AdminHeader() {
  const { session, state } = useAuth();
  if (state.status !== "authenticated") return null;
  return (
    <div className="admin-bar" data-testid="admin-bar">
      <span>
        {state.user.email} ({ROLE_LABELS[state.user.role]})
      </span>
      <Link href="/">Member app</Link>
      <button type="button" className="link" onClick={() => void session.logOut()}>
        Log out
      </button>
    </div>
  );
}
