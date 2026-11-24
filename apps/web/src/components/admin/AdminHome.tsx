"use client";

import { canSetUpClubs } from "@padelloyalty/shared";
import Link from "next/link";
import { BackOfficeGate } from "./BackOfficeGate";

export function AdminHome() {
  return (
    <BackOfficeGate>
      {(user) => (
        <section className="card" data-testid="admin-home">
          <h2>Tools</h2>
          {canSetUpClubs(user.role) ? (
            <ul className="tool-list">
              <li>
                <Link href="/admin/clubs/">Clubs and courts</Link>
                <span className="muted-block">
                  Clubs, opening hours, courts, slot lengths, prices and court blocks.
                </span>
              </li>
            </ul>
          ) : (
            <p>Check-ins, bookings and member tools for staff will appear here.</p>
          )}
        </section>
      )}
    </BackOfficeGate>
  );
}
