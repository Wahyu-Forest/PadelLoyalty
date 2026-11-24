import cors from "@fastify/cors";
import Fastify, { type FastifyServerOptions } from "fastify";
import { RateLimiter, type RateLimitRules } from "./auth/rate-limit.js";
import { ConsentService } from "./auth/consent-service.js";
import { authRoutes } from "./auth/routes.js";
import { AuthService } from "./auth/service.js";
import type { Database } from "./db/client.js";
import type { Mailer } from "./email/mailer.js";
import { registerErrorHandling } from "./http/errors.js";
import { healthRoutes } from "./routes/health.js";

export interface AuthOptions {
  db: Database;
  mailer: Mailer;
  /** Web app base URL (with any base path) used in email links. */
  appUrl: string;
  /** Clock, overridable in tests for expiry checks. Defaults to the real time. */
  now?: () => Date;
  /** Override some rate-limit rules, or `false` to disable rate limiting. */
  rateLimits?: Partial<RateLimitRules> | false;
}

export interface AppOptions {
  checkDatabase: () => Promise<boolean>;
  corsOrigins: string[];
  logger?: FastifyServerOptions["logger"];
  /** Trust X-Forwarded-For from a reverse proxy (for per-IP rate limits). */
  trustProxy?: boolean;
  /** Auth routes are registered only when given. */
  auth?: AuthOptions;
}

export async function buildApp(options: AppOptions) {
  const app = Fastify({ logger: options.logger ?? false, trustProxy: options.trustProxy ?? false });

  registerErrorHandling(app);
  await app.register(cors, {
    origin: options.corsOrigins,
    // Clients show "try again in N seconds" on 429.
    exposedHeaders: ["retry-after"],
  });
  await app.register(healthRoutes, { checkDatabase: options.checkDatabase });

  if (options.auth) {
    const now = options.auth.now ?? (() => new Date());
    const shared = {
      db: options.auth.db,
      mailer: options.auth.mailer,
      appUrl: options.auth.appUrl,
      now,
      limiter: new RateLimiter(options.auth.rateLimits ?? {}, () => now().getTime()),
    };
    const service = new AuthService({ ...shared, consent: new ConsentService(shared) });
    app.decorate("authService", service);
    await app.register(authRoutes, { service });
  }

  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    /** Present when the app was built with `auth`. Use with `requireAuth(app.authService)`. */
    authService?: AuthService;
  }
}
