import { healthResponseSchema } from "@padelloyalty/shared";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

type App = Awaited<ReturnType<typeof buildApp>>;
let app: App | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function appWithDatabase(up: boolean) {
  app = await buildApp({
    checkDatabase: async () => up,
    corsOrigins: ["http://localhost:3000"],
  });
  return app;
}

describe("GET /health (database stubbed)", () => {
  it("returns 200 and status ok when the database is up", async () => {
    const response = await (await appWithDatabase(true)).inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    const body = healthResponseSchema.parse(response.json());
    expect(body).toMatchObject({ status: "ok", database: "up" });
  });

  it("returns 503 and status degraded when the database is down", async () => {
    const response = await (await appWithDatabase(false)).inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(503);
    const body = healthResponseSchema.parse(response.json());
    expect(body).toMatchObject({ status: "degraded", database: "down" });
  });

  it("allows the configured web origin via CORS", async () => {
    const response = await (
      await appWithDatabase(true)
    ).inject({
      method: "GET",
      url: "/health",
      headers: { origin: "http://localhost:3000" },
    });

    expect(response.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
  });

  it("does not allow other origins", async () => {
    const response = await (
      await appWithDatabase(true)
    ).inject({
      method: "GET",
      url: "/health",
      headers: { origin: "https://evil.example.com" },
    });

    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
