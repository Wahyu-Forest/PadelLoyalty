import { buildApp } from "./app.js";
import { createDatabase, isDatabaseReachable } from "./db/client.js";
import { ConsoleMailer } from "./email/mailer.js";
import { loadEnv } from "./env.js";

const env = loadEnv();
const { db, pool } = createDatabase(env.DATABASE_URL);

const app = await buildApp({
  checkDatabase: () => isDatabaseReachable(db),
  corsOrigins: env.CORS_ORIGINS,
  logger: { level: env.LOG_LEVEL },
  trustProxy: env.TRUST_PROXY,
  auth: {
    db,
    // No email provider yet: emails (with their links) are printed to the console.
    mailer: new ConsoleMailer(),
    appUrl: env.APP_URL,
  },
});

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  await app.close();
  await pool.end();
  process.exit(0);
};
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ host: env.HOST, port: env.PORT });
} catch (error) {
  app.log.error(error);
  await pool.end();
  process.exit(1);
}
