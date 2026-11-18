import { z } from "zod";

/**
 * Response body of `GET /health` on the API.
 * Used by the API to build the response and by the web app to validate it.
 */
export const healthResponseSchema = z.object({
  /** `ok` when every dependency is reachable, `degraded` otherwise. */
  status: z.enum(["ok", "degraded"]),
  /** Whether the API could reach PostgreSQL. */
  database: z.enum(["up", "down"]),
  /** When the check ran (ISO 8601, UTC). */
  timestamp: z.iso.datetime(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
