"use client";

import { POINTS_NAME } from "@padelloyalty/shared";
import { errorMessage } from "@/lib/auth/api";
import { formatPoints } from "@/lib/points/balance";
import { Notice } from "../auth/Form";
import { usePointsBalance } from "./usePointsBalance";

/** The member home's balance card (#6): the current balance at a glance. */
export function PointsBalance({ userId }: { userId: string }) {
  const { state, reload } = usePointsBalance(userId);
  const busy = state.status === "loading" || (state.status === "loaded" && state.refreshing);

  return (
    <section
      className="card points"
      data-testid="points-balance"
      data-state={state.status}
      aria-labelledby="points-heading"
      aria-busy={busy}
    >
      <h2 id="points-heading" className="eyebrow">
        Your {POINTS_NAME}
      </h2>

      {state.status === "loading" ? (
        <>
          <p className="points-value placeholder-value" aria-hidden="true">
            &nbsp;
          </p>
          <p className="muted" role="status">
            Loading your balance…
          </p>
        </>
      ) : state.status === "error" ? (
        <Notice tone="warn" testId="points-error">
          <p>
            We couldn&apos;t load your {POINTS_NAME}. {errorMessage(state.error)}
          </p>
          <button type="button" className="secondary" onClick={() => void reload()}>
            Try again
          </button>
        </Notice>
      ) : (
        <>
          <p className="points-value" aria-live="polite">
            <span data-testid="points-balance-value">{formatPoints(state.balance)}</span>{" "}
            <span className="points-unit">{POINTS_NAME}</span>
          </p>
          {state.balance === 0 ? (
            <p className="muted" data-testid="points-zero">
              No {POINTS_NAME} yet. You&apos;ll earn them when you check in for a game.
            </p>
          ) : null}
          {state.refreshError ? (
            <p className="muted" data-testid="points-refresh-error" role="status">
              Couldn&apos;t update just now; this is your last known balance.{" "}
              <button type="button" className="link" onClick={() => void reload()}>
                Try again
              </button>
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
