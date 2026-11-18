import { describe, expect, it } from "vitest";
import { DEFAULT_CORS_ORIGINS, loadEnv } from "../src/env.js";

const DATABASE_URL = "postgres://padel:padel@localhost:5432/padelloyalty";

describe("loadEnv", () => {
  it("applies defaults when only DATABASE_URL is set", () => {
    expect(loadEnv({ DATABASE_URL })).toEqual({
      DATABASE_URL,
      HOST: "0.0.0.0",
      PORT: 4000,
      CORS_ORIGINS: DEFAULT_CORS_ORIGINS,
      APP_URL: "http://localhost:3000",
      TRUST_PROXY: false,
      LOG_LEVEL: "info",
    });
  });

  it("parses PORT and a comma-separated CORS_ORIGINS list", () => {
    const env = loadEnv({
      DATABASE_URL,
      PORT: "8080",
      CORS_ORIGINS: " https://app.example.com , https://admin.example.com ,",
    });
    expect(env.PORT).toBe(8080);
    expect(env.CORS_ORIGINS).toEqual(["https://app.example.com", "https://admin.example.com"]);
  });

  it("fails clearly when DATABASE_URL is missing", () => {
    expect(() => loadEnv({})).toThrow(/DATABASE_URL is required/);
    expect(() => loadEnv({ DATABASE_URL: "" })).toThrow(/DATABASE_URL is required/);
  });

  it("rejects an invalid PORT", () => {
    expect(() => loadEnv({ DATABASE_URL, PORT: "not-a-port" })).toThrow(/PORT/);
  });

  it("normalises APP_URL and parses TRUST_PROXY", () => {
    const env = loadEnv({
      DATABASE_URL,
      APP_URL: "https://wahyu-forest.github.io/PadelLoyalty/",
      TRUST_PROXY: "true",
    });
    expect(env.APP_URL).toBe("https://wahyu-forest.github.io/PadelLoyalty");
    expect(env.TRUST_PROXY).toBe(true);
    expect(() => loadEnv({ DATABASE_URL, APP_URL: "not a url" })).toThrow(/APP_URL/);
    expect(() => loadEnv({ DATABASE_URL, TRUST_PROXY: "yes" })).toThrow(/TRUST_PROXY/);
  });
});
