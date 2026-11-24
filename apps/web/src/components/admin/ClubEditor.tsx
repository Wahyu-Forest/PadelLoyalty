"use client";

import type { AdminClubDetailResponse } from "@padelloyalty/shared";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { errorMessage } from "@/lib/auth/api";
import { FormError } from "../auth/Form";
import { BlocksPanel } from "./BlocksPanel";
import { ClubForm } from "./ClubForm";
import { CourtsPanel } from "./CourtsPanel";
import { PricingPanel } from "./PricingPanel";
import { useClubsApi } from "./useClubsApi";

const TABS = [
  { id: "details", label: "Details & hours" },
  { id: "courts", label: "Courts" },
  { id: "prices", label: "Prices" },
  { id: "blocks", label: "Blocks" },
] as const;
type Tab = (typeof TABS)[number]["id"];

type State =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; detail: AdminClubDetailResponse };

/** One club's setup: details and hours, courts, prices and blocks (`/admin/club/?id=…`). */
export function ClubEditor() {
  const clubId = useSearchParams().get("id") ?? "";
  const api = useClubsApi();
  const [state, setState] = useState<State>({ status: "loading" });
  const [tab, setTab] = useState<Tab>("details");
  const [reloads, setReloads] = useState(0);
  const reload = useCallback(() => setReloads((n) => n + 1), []);

  useEffect(() => {
    if (!clubId) return;
    let cancelled = false;
    void api.getClub(clubId).then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setState({ status: "ready", detail: result.data });
      } else {
        setState({
          status: "error",
          message:
            result.error.code === "not_found"
              ? "This club doesn't exist."
              : errorMessage(result.error),
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [api, clubId, reloads]);

  const shown: State = clubId ? state : { status: "error", message: "No club selected." };

  if (shown.status === "loading") {
    return (
      <section className="card" aria-busy="true">
        <p>Loading club…</p>
      </section>
    );
  }
  if (shown.status === "error") {
    return (
      <section className="card">
        <FormError message={shown.message} />
        <p>
          <Link href="/admin/clubs/">All clubs</Link>
        </p>
      </section>
    );
  }

  const { club, courts, pricing } = shown.detail;
  return (
    <div className="stack">
      <div className="row-between">
        <div>
          <h2 className="club-title" data-testid="club-title">
            {club.name}
          </h2>
          <p className="muted">
            {club.address} · {club.timeZone} · {club.currency}
            {club.active ? "" : " · Inactive"}
          </p>
        </div>
        <Link href="/admin/clubs/">All clubs</Link>
      </div>
      <div className="tabs" role="tablist" aria-label="Club setup">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`panel-${t.id}`}
            className={tab === t.id ? "tab active" : "tab"}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === "details" ? (
          <ClubForm
            club={club}
            currencyLocked={pricing !== null}
            submitLabel="Save details"
            submit={(body) => api.updateClub(club.id, body)}
            onSaved={reload}
          />
        ) : null}
        {tab === "courts" ? (
          <CourtsPanel clubId={club.id} courts={courts} onChanged={reload} />
        ) : null}
        {tab === "prices" ? (
          <PricingPanel
            clubId={club.id}
            currency={club.currency}
            pricing={pricing}
            onChanged={reload}
          />
        ) : null}
        {tab === "blocks" ? (
          <BlocksPanel clubId={club.id} timeZone={club.timeZone} courts={courts} />
        ) : null}
      </div>
    </div>
  );
}
