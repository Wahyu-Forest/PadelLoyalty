"use client";

import type { AdminClubSummary } from "@padelloyalty/shared";
import Link from "next/link";
import { useEffect, useState } from "react";
import { errorMessage } from "@/lib/auth/api";
import { FormError } from "../auth/Form";
import { useClubsApi } from "./useClubsApi";

type State =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; clubs: AdminClubSummary[] };

export function ClubList() {
  const api = useClubsApi();
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    void api.listClubs().then((result) => {
      if (cancelled) return;
      setState(
        result.ok
          ? { status: "ready", clubs: result.data.clubs }
          : { status: "error", message: errorMessage(result.error) },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [api]);

  return (
    <section className="card">
      <div className="row-between">
        <h2>Clubs</h2>
        <Link className="button" href="/admin/clubs/new/">
          New club
        </Link>
      </div>
      {state.status === "loading" ? <p aria-busy="true">Loading clubs…</p> : null}
      {state.status === "error" ? <FormError message={state.message} /> : null}
      {state.status === "ready" && state.clubs.length === 0 ? (
        <p data-testid="no-clubs">No clubs yet. Create the first one.</p>
      ) : null}
      {state.status === "ready" && state.clubs.length > 0 ? (
        <div className="table-wrap">
          <table data-testid="club-list">
            <thead>
              <tr>
                <th scope="col">Club</th>
                <th scope="col">Status</th>
                <th scope="col">Courts</th>
                <th scope="col">Prices</th>
                <th scope="col">Time zone</th>
              </tr>
            </thead>
            <tbody>
              {state.clubs.map((club) => (
                <tr key={club.id} data-testid="club-row">
                  <th scope="row">
                    <Link href={`/admin/club/?id=${club.id}`}>{club.name}</Link>
                    <span className="muted-block">{club.address}</span>
                  </th>
                  <td>
                    <span className="badge" data-tone={club.active ? "ok" : "off"}>
                      {club.active ? "Active" : "Inactive"}
                    </span>
                  </td>
                  <td>
                    {club.activeCourtCount} active
                    {club.courtCount > club.activeCourtCount
                      ? ` (${club.courtCount - club.activeCourtCount} inactive)`
                      : ""}
                  </td>
                  <td>{club.hasPricing ? `Set (${club.currency})` : "Not set"}</td>
                  <td>{club.timeZone}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
