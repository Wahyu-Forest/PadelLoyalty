import cors from "@fastify/cors";
import Fastify, { type FastifyServerOptions } from "fastify";
import { healthRoutes } from "./routes/health.js";

export interface AppOptions {
  checkDatabase: () => Promise<boolean>;
  corsOrigins: string[];
  logger?: FastifyServerOptions["logger"];
}

export async function buildApp(options: AppOptions) {
  const app = Fastify({ logger: options.logger ?? false });

  await app.register(cors, { origin: options.corsOrigins });
  await app.register(healthRoutes, { checkDatabase: options.checkDatabase });

  return app;
}
