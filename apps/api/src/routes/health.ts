import { healthResponseSchema, type HealthResponse } from "@padelloyalty/shared";
import type { FastifyPluginAsync } from "fastify";

export interface HealthRouteOptions {
  /** Resolves to true when PostgreSQL is reachable. Must not throw. */
  checkDatabase: () => Promise<boolean>;
}

export const healthRoutes: FastifyPluginAsync<HealthRouteOptions> = async (app, options) => {
  app.get("/health", async (_request, reply) => {
    const databaseUp = await options.checkDatabase();
    const body: HealthResponse = healthResponseSchema.parse({
      status: databaseUp ? "ok" : "degraded",
      database: databaseUp ? "up" : "down",
      timestamp: new Date().toISOString(),
    });
    // 503 lets load balancers and uptime checks see the outage; the body
    // still says which dependency failed.
    return reply.code(databaseUp ? 200 : 503).send(body);
  });
};
