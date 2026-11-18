import { describe, expect, it, vi } from "vitest";
import { fetchHealth } from "./health";

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
});
