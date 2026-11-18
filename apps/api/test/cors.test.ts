import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadEnv } from "../src/env.js";

// With no CORS_ORIGINS set, the API must still accept the web dev server and
// both Capacitor web views, or the native apps cannot show the API status.
type App = Awaited<ReturnType<typeof buildApp>>;
let app: App | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function appWithDefaultCors() {
  const env = loadEnv({ DATABASE_URL: "postgres://unused" });
  app = await buildApp({ checkDatabase: async () => true, corsOrigins: env.CORS_ORIGINS });
  return app;
}

describe("default CORS origins", () => {
  it.each([
    ["Next.js dev server", "http://localhost:3000"],
    ["Capacitor Android", "https://localhost"],
    ["Capacitor iOS", "capacitor://localhost"],
  ])("allows the %s origin (%s)", async (_name, origin) => {
    const response = await (
      await appWithDefaultCors()
    ).inject({ method: "GET", url: "/health", headers: { origin } });

    expect(response.statusCode).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe(origin);
  });

  it("answers a CORS preflight for GET /health from the Android web view", async () => {
    const response = await (
      await appWithDefaultCors()
    ).inject({
      method: "OPTIONS",
      url: "/health",
      headers: { origin: "https://localhost", "access-control-request-method": "GET" },
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe("https://localhost");
  });

  it("does not allow an unlisted origin", async () => {
    const response = await (
      await appWithDefaultCors()
    ).inject({ method: "GET", url: "/health", headers: { origin: "http://localhost:8080" } });

    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
