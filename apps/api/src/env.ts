import { z } from "zod";

export const DEFAULT_CORS_ORIGINS = [
  "http://localhost:3000", // Next.js dev server
  "capacitor://localhost", // Capacitor iOS
  "https://localhost", // Capacitor Android
];

const envSchema = z.object({
  DATABASE_URL: z.string({ error: "DATABASE_URL is required" }).min(1, "DATABASE_URL is required"),
  HOST: z.string().min(1).default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  CORS_ORIGINS: z
    .string()
    .optional()
    .transform((value) =>
      value === undefined || value.trim() === ""
        ? DEFAULT_CORS_ORIGINS
        : value
            .split(",")
            .map((origin) => origin.trim())
            .filter((origin) => origin.length > 0),
    ),
  /** Web app base URL (with any base path) for links in emails, e.g. https://wahyu-forest.github.io/PadelLoyalty */
  APP_URL: z
    .url({ error: "APP_URL must be a URL such as http://localhost:3000" })
    .default("http://localhost:3000")
    .transform((value) => value.replace(/\/+$/, "")),
  /** Set to true behind a reverse proxy so per-IP rate limits see the client IP. */
  TRUST_PROXY: z
    .enum(["true", "false", ""])
    .default("false")
    .transform((value) => value === "true"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});

export type Env = z.infer<typeof envSchema>;

/** Validates environment variables; throws a readable error listing every problem. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new Error(`Invalid API environment:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
