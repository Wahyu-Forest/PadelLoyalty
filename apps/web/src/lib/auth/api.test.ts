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

  it("sends the bearer token for /auth/me", async () => {
    const fetchImpl = vi.fn(async () => json({ user: sessionBody(1).user }));
    await new AuthApi(API, fetchImpl as typeof fetch).me("pla_x");

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer pla_x");
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
