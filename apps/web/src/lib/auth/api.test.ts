import { describe, expect, it, vi } from "vitest";
import { AuthApi, errorMessage, formatRetryAfter } from "./api";
import { json, sessionBody } from "./test-support";

const API = "http://api.test";

describe("AuthApi", () => {
  it("posts JSON to {apiUrl}/auth/login and validates the session", async () => {
    const fetchImpl = vi.fn(async () => json(sessionBody(1)));
    const result = await new AuthApi(API, fetchImpl as typeof fetch).logIn({
      email: "ana@example.com",
      password: "pw",
    });

    expect(result.ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${API}/auth/login`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ email: "ana@example.com", password: "pw" });
    expect(init.credentials).toBeUndefined(); // tokens, not cookies
  });

  it("gets the points balance (#6) with the bearer token and validates it", async () => {
    const body = { balance: 1250, asOf: "2026-11-24T10:00:00.000Z" };
    const fetchImpl = vi.fn(async () => json(body));
    const result = await new AuthApi(API, fetchImpl as typeof fetch).pointsBalance("pla_x");

    expect(result).toEqual({ ok: true, data: body });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${API}/points/balance`);
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer pla_x");

    const bad = await new AuthApi(API, (async () =>
      json({ balance: "lots", asOf: body.asOf })) as typeof fetch).pointsBalance("pla_x");
    expect(bad).toMatchObject({ ok: false, error: { code: "invalid_response" } });

    const pending = await new AuthApi(API, (async () =>
      json(
        { error: { code: "account_not_active", message: "Verify your email." } },
        403,
      )) as typeof fetch).pointsBalance("pla_x");
    expect(pending).toMatchObject({ ok: false, error: { code: "account_not_active" } });
  });

  it("sends the bearer token for /auth/me", async () => {
    const fetchImpl = vi.fn(async () => json({ user: sessionBody(1).user }));
    await new AuthApi(API, fetchImpl as typeof fetch).me("pla_x");

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer pla_x");
  });

  it("calls the consent endpoints (#3) with the right method, auth and body", async () => {
    const status = {
      state: "pending",
      guardianEmail: "mum@example.com",
      requestedAt: "2026-11-24T10:00:00.000Z",
      expiresAt: "2026-12-01T10:00:00.000Z",
      decidedAt: null,
    };
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/review")) {
        return json({
          memberEmail: "kid@example.com",
          memberDateOfBirth: "2012-05-01",
          guardianEmail: "mum@example.com",
          expiresAt: "2026-12-01T10:00:00.000Z",
        });
      }
      if (url.endsWith("/decision")) return json({ message: "Thanks", decision: "confirm" });
      return json(status);
    });
    const api = new AuthApi(API, fetchImpl as unknown as typeof fetch);

    expect((await api.consentStatus("pla_x")).ok).toBe(true);
    expect((await api.requestConsent("pla_x", { guardianEmail: "dad@example.com" })).ok).toBe(true);
    expect((await api.reviewConsent("plc_1")).ok).toBe(true);
    expect(
      (await api.decideConsent({ token: "plc_1", decision: "confirm", isParentOrGuardian: true }))
        .ok,
    ).toBe(true);

    const calls = fetchImpl.mock.calls as unknown as [string, RequestInit][];
    const summary = calls.map(([url, init]) => [
      url.replace(API, ""),
      init.method,
      (init.headers as Record<string, string>).authorization ?? null,
      init.body ? JSON.parse(String(init.body)) : null,
    ]);
    expect(summary).toEqual([
      ["/auth/consent", "GET", "Bearer pla_x", null],
      ["/auth/consent/request", "POST", "Bearer pla_x", { guardianEmail: "dad@example.com" }],
      ["/auth/consent/review", "POST", null, { token: "plc_1" }],
      [
        "/auth/consent/decision",
        "POST",
        null,
        { token: "plc_1", decision: "confirm", isParentOrGuardian: true },
      ],
    ]);
  });

  it("returns the API error with field errors and Retry-After", async () => {
    const fetchImpl = async () =>
      json({ error: { code: "rate_limited", message: "Too many" } }, 429, { "retry-after": "90" });
    const result = await new AuthApi(API, fetchImpl as typeof fetch).logIn({
      email: "a@b.co",
      password: "x",
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "rate_limited", message: "Too many", retryAfterSeconds: 90 },
    });
  });

  it("accepts 204 with no body for logout", async () => {
    const fetchImpl = async () => new Response(null, { status: 204 });
    expect(await new AuthApi(API, fetchImpl as typeof fetch).logOut("plr_x")).toEqual({
      ok: true,
      data: null,
    });
  });

  it("reports network errors, missing API and malformed answers", async () => {
    const failing = async () => {
      throw new TypeError("Failed to fetch");
    };
    expect(
      (
        await new AuthApi(API, failing as typeof fetch).signUp({
          email: "a@b.co",
          password: "x",
          dateOfBirth: "1990-01-01",
        })
      ).ok,
    ).toBe(false);
    const noApi = vi.fn();
    const result = await new AuthApi(null, noApi as typeof fetch).resendVerification("a@b.co");
    expect(result).toMatchObject({ ok: false, error: { code: "network_error" } });
    expect(noApi).not.toHaveBeenCalled();

    const bad = async () => json({ nope: true });
    expect(await new AuthApi(API, bad as typeof fetch).refresh("plr_x")).toMatchObject({
      ok: false,
      error: { code: "invalid_response" },
    });
  });
});

describe("error messages", () => {
  it("formats waits", () => {
    expect(formatRetryAfter(1)).toBe("in 1 second");
    expect(formatRetryAfter(45)).toBe("in 45 seconds");
    expect(formatRetryAfter(61)).toBe("in 2 minutes");
    expect(formatRetryAfter(undefined)).toBe("later");
    expect(errorMessage({ code: "rate_limited", message: "x", retryAfterSeconds: 600 })).toBe(
      "Too many attempts. Please try again in 10 minutes.",
    );
  });
});
