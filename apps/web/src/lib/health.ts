import { healthResponseSchema, type HealthResponse } from "@padelloyalty/shared";

export type HealthResult = { ok: true; health: HealthResponse } | { ok: false; error: string };

/** How long to wait for `GET /health` (headers and body) before giving up. */
export const HEALTH_TIMEOUT_MS = 5_000;

/**
 * Calls `GET {apiUrl}/health`. The API answers 200 when healthy and 503 when
 * the database is down; both carry a body we can show, so both count as a
 * successful call. Network failures and malformed bodies are errors.
 *
 * Gives up after `timeoutMs` (an API that accepts the connection but never
 * answers, e.g. a wrong LAN address on a device) and aborts the request.
 * `signal` lets the caller cancel early, e.g. when the component unmounts.
 * `apiUrl` is null when the build has no API configured: no request is made.
 */
export async function fetchHealth(
  apiUrl: string | null,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
  timeoutMs: number = HEALTH_TIMEOUT_MS,
): Promise<HealthResult> {
  if (apiUrl === null) return { ok: false, error: "API unreachable" };

  // Combine the caller's signal with our timeout by hand rather than with
  // AbortSignal.any/timeout, which older Android WebViews lack.
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) forwardAbort();
  else signal?.addEventListener("abort", forwardAbort, { once: true });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<HealthResult>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({
        ok: false,
        error: `API unreachable (no response after ${Math.round(timeoutMs / 1000)}s)`,
      });
    }, timeoutMs);
  });

  try {
    // Racing also covers a fetchImpl or body stream that ignores the abort.
    return await Promise.race([requestHealth(apiUrl, fetchImpl, controller.signal), timedOut]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", forwardAbort);
  }
}

async function requestHealth(
  apiUrl: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
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
