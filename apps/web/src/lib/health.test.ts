import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchHealth, HEALTH_TIMEOUT_MS } from "./health";

const API = "http://api.test";
const timestamp = "2026-11-18T10:00:00.000Z";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("fetchHealth", () => {
  it("calls {apiUrl}/health and returns the parsed body", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ status: "ok", database: "up", timestamp }));

    const result = await fetchHealth(API, fetchImpl as typeof fetch);

    expect(fetchImpl).toHaveBeenCalledWith(`${API}/health`, expect.any(Object));
    expect(result).toEqual({ ok: true, health: { status: "ok", database: "up", timestamp } });
  });

  it("treats 503 with a valid body as a degraded health report", async () => {
    const fetchImpl = async () =>
      jsonResponse({ status: "degraded", database: "down", timestamp }, 503);

    const result = await fetchHealth(API, fetchImpl as typeof fetch);

    expect(result).toEqual({
      ok: true,
      health: { status: "degraded", database: "down", timestamp },
    });
  });

  it("reports the API as unreachable on a network error", async () => {
    const fetchImpl = async () => {
      throw new TypeError("Failed to fetch");
    };

    expect(await fetchHealth(API, fetchImpl as typeof fetch)).toEqual({
      ok: false,
      error: "API unreachable",
    });
  });

  it("reports the API as unreachable without a request when no API is configured", async () => {
    const fetchImpl = vi.fn();

    expect(await fetchHealth(null, fetchImpl as typeof fetch)).toEqual({
      ok: false,
      error: "API unreachable",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports other HTTP errors", async () => {
    const fetchImpl = async () => new Response("nope", { status: 500 });

    expect(await fetchHealth(API, fetchImpl as typeof fetch)).toEqual({
      ok: false,
      error: "API error (HTTP 500)",
    });
  });

  it("rejects a body that does not match the shared schema", async () => {
    const fetchImpl = async () => jsonResponse({ status: "great" });

    expect(await fetchHealth(API, fetchImpl as typeof fetch)).toEqual({
      ok: false,
      error: "Invalid response from API",
    });
  });

  describe("timeout", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    const timedOut = { ok: false, error: "API unreachable (no response after 5s)" };

    it("defaults to 5 seconds", () => {
      expect(HEALTH_TIMEOUT_MS).toBe(5_000);
    });

    it("reports the API as unreachable when the request never settles", async () => {
      vi.useFakeTimers();
      // Accepts the connection but never answers, and ignores the abort signal.
      const fetchImpl = () => new Promise<Response>(() => {});
      let result: unknown = "pending";
      void fetchHealth(API, fetchImpl as typeof fetch).then((r) => (result = r));

      await vi.advanceTimersByTimeAsync(HEALTH_TIMEOUT_MS - 1);
      expect(result).toBe("pending");
      await vi.advanceTimersByTimeAsync(1);
      expect(result).toEqual(timedOut);
    });

    it("aborts the underlying request when it times out", async () => {
      vi.useFakeTimers();
      let requestSignal: AbortSignal | undefined;
      const fetchImpl = (_url: string, init?: RequestInit) => {
        requestSignal = init?.signal ?? undefined;
        return new Promise<Response>(() => {});
      };
      const result = fetchHealth(API, fetchImpl as typeof fetch, undefined, 1_000);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(await result).toEqual({ ok: false, error: "API unreachable (no response after 1s)" });
      expect(requestSignal?.aborted).toBe(true);
    });

    it("times out when the headers arrive but the body never finishes", async () => {
      vi.useFakeTimers();
      const fetchImpl = async () =>
        new Response(new ReadableStream({ start: () => {} }), { status: 200 });
      const result = fetchHealth(API, fetchImpl as typeof fetch);

      await vi.advanceTimersByTimeAsync(HEALTH_TIMEOUT_MS);
      expect(await result).toEqual(timedOut);
    });

    it("clears the timer once the API answers", async () => {
      vi.useFakeTimers();
      const fetchImpl = async () => jsonResponse({ status: "ok", database: "up", timestamp });

      expect((await fetchHealth(API, fetchImpl as typeof fetch)).ok).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("passes the caller's abort (e.g. unmount) through to the request", async () => {
      let requestSignal: AbortSignal | undefined;
      const fetchImpl = (_url: string, init?: RequestInit) => {
        requestSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) =>
          init?.signal?.addEventListener("abort", () => reject(new DOMException("", "AbortError"))),
        );
      };
      const caller = new AbortController();
      const result = fetchHealth(API, fetchImpl as typeof fetch, caller.signal);

      caller.abort();
      expect(requestSignal?.aborted).toBe(true);
      expect(await result).toEqual({ ok: false, error: "API unreachable" });
    });
  });
});
