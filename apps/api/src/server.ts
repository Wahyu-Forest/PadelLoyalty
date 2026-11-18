import { buildApp } from "./app.js";
import { createDatabase, isDatabaseReachable } from "./db/client.js";
import { loadEnv } from "./env.js";

const env = loadEnv();
const { db, pool } = createDatabase(env.DATABASE_URL);

const app = await buildApp({
  checkDatabase: () => isDatabaseReachable(db),
  corsOrigins: env.CORS_ORIGINS,
  logger: { level: env.LOG_LEVEL },
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
