import type { ApiErrorCode, ApiErrorResponse } from "@padelloyalty/shared";
import type { FastifyError, FastifyInstance } from "fastify";
import { z } from "zod";

/** An error the API reports to the client as `{ error: { code, message } }`. */
export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly options: { fieldErrors?: Record<string, string[]>; retryAfterSeconds?: number } = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function rateLimited(retryAfterSeconds: number): ApiError {
  return new ApiError(429, "rate_limited", "Too many attempts. Please wait and try again.", {
    retryAfterSeconds,
  });
}

/** Parses a request body with a shared Zod schema, or throws a 400 `validation_error`. */
export function parseBody<T extends z.ZodType>(schema: T, body: unknown): z.output<T> {
  const result = schema.safeParse(body ?? {});
  if (result.success) return result.data;
  const flattened = z.flattenError(result.error);
  const fieldErrors: Record<string, string[]> = {};
  for (const [field, messages] of Object.entries(flattened.fieldErrors)) {
    if (Array.isArray(messages) && messages.length > 0) fieldErrors[field] = messages;
  }
  if (flattened.formErrors.length > 0) fieldErrors._ = flattened.formErrors;
  return throwValidation(fieldErrors);
}

function throwValidation(fieldErrors: Record<string, string[]>): never {
  throw new ApiError(400, "validation_error", "Some fields are missing or invalid.", {
    fieldErrors,
  });
}

function body(
  code: ApiErrorCode,
  message: string,
  fieldErrors?: Record<string, string[]>,
): ApiErrorResponse {
  return { error: { code, message, ...(fieldErrors ? { fieldErrors } : {}) } };
}

/** Uniform error bodies for every route, including Fastify's own errors and 404s. */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError | ApiError, request, reply) => {
    if (error instanceof ApiError) {
      if (error.options.retryAfterSeconds !== undefined) {
        void reply.header("retry-after", String(error.options.retryAfterSeconds));
      }
      return reply
        .code(error.statusCode)
        .send(body(error.code, error.message, error.options.fieldErrors));
    }
    const status = error.statusCode ?? 500;
    if (status >= 400 && status < 500) {
      // Malformed JSON, wrong content type, body too large, etc.
      return reply
        .code(status === 413 || status === 415 ? status : 400)
        .send(body("validation_error", "The request body could not be read."));
    }
    request.log.error(error);
    return reply.code(500).send(body("internal_error", "Something went wrong. Please try again."));
  });

  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send(body("not_found", "Not found.")),
  );
}
