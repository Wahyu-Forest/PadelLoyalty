"use client";

import { useEffect, useState } from "react";
import { apiUrl } from "@/lib/config";
import { fetchHealth, type HealthResult } from "@/lib/health";

type State = { kind: "loading" } | { kind: "done"; result: HealthResult };

export function ApiStatus() {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    fetchHealth(apiUrl, fetch, controller.signal).then((result) => {
      if (!controller.signal.aborted) setState({ kind: "done", result });
    });
    return () => controller.abort();
  }, []);

  let tone: "pending" | "ok" | "warn" | "error" = "pending";
  let api = "Checking…";
  let database = "Checking…";

  if (state.kind === "done") {
    if (state.result.ok) {
      const { health } = state.result;
      tone = health.status === "ok" ? "ok" : "warn";
      api = "Online";
      database = health.database === "up" ? "Up" : "Down";
    } else {
      tone = "error";
      api = state.result.error;
      database = "Unknown";
    }
  }

  return (
    <section className="status" data-tone={tone} aria-live="polite" data-testid="api-status">
      <h2>System status</h2>
      <dl>
        <dt>API</dt>
        <dd data-testid="api-status-api">{api}</dd>
        <dt>Database</dt>
        <dd data-testid="api-status-database">{database}</dd>
      </dl>
      <p className="muted">{apiUrl ?? "No API configured for this build"}</p>
    </section>
  );
}
