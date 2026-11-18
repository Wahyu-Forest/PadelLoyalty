import { healthResponseSchema, type HealthResponse } from "@padelloyalty/shared";

export type HealthResult = { ok: true; health: HealthResponse } | { ok: false; error: string };

/**
 * Calls `GET {apiUrl}/health`. The API answers 200 when healthy and 503 when
 * the database is down; both carry a body we can show, so both count as a
 * successful call. Network failures and malformed bodies are errors.
 */
export async function fetchHealth(
  apiUrl: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<HealthResult> {
  let response: Response;
  try {
    response = await fetchImpl(`${apiUrl}/health`, {
      headers: { accept: "application/json" },
      cache: "no-store",
      signal,
    });
  } catch {
    return { ok: false, error: "API unreachable" };
  }

  if (!response.ok && response.status !== 503) {
    return { ok: false, error: `API error (HTTP ${response.status})` };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, error: "Invalid response from API" };
  }

  const parsed = healthResponseSchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, error: "Invalid response from API" };
  }
  return { ok: true, health: parsed.data };
}
