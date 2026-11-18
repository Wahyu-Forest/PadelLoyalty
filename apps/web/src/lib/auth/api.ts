import {
  apiErrorResponseSchema,
  authSessionResponseSchema,
  meResponseSchema,
  messageResponseSchema,
  verifyEmailResponseSchema,
  type ApiErrorCode,
  type AuthSessionResponse,
  type LogInRequest,
  type MeResponse,
  type MessageResponse,
  type PasswordResetConfirmRequest,
  type SignUpRequest,
  type VerifyEmailResponse,
} from "@padelloyalty/shared";
import type { z } from "zod";

/** API error codes plus the client-side ones for failures before an answer. */
export type ClientErrorCode = ApiErrorCode | "network_error" | "invalid_response";

export interface ClientError {
  code: ClientErrorCode;
  message: string;
  fieldErrors?: Record<string, string[]>;
  retryAfterSeconds?: number;
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ClientError };

export const REQUEST_TIMEOUT_MS = 15_000;

const NETWORK_ERROR: ClientError = {
  code: "network_error",
  message: "Can't reach Soul Padel right now. Check your connection and try again.",
};

/** Calls the auth endpoints described in docs/api/auth.md. */
export class AuthApi {
  constructor(
    private readonly apiUrl: string | null,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {}

  signUp(body: SignUpRequest) {
    return this.request("/auth/signup", messageResponseSchema, { body });
  }

  verifyEmail(token: string) {
    return this.request("/auth/verify-email", verifyEmailResponseSchema, { body: { token } });
  }

  resendVerification(email: string) {
    return this.request("/auth/verify-email/resend", messageResponseSchema, { body: { email } });
  }

  logIn(body: LogInRequest) {
    return this.request("/auth/login", authSessionResponseSchema, { body });
  }

  refresh(refreshToken: string) {
    return this.request("/auth/refresh", authSessionResponseSchema, { body: { refreshToken } });
  }

  logOut(refreshToken: string) {
    return this.request("/auth/logout", null, { body: { refreshToken } });
  }

  me(accessToken: string) {
    return this.request("/auth/me", meResponseSchema, { method: "GET", accessToken });
  }

  requestPasswordReset(email: string) {
    return this.request("/auth/password-reset/request", messageResponseSchema, {
      body: { email },
    });
  }

  confirmPasswordReset(body: PasswordResetConfirmRequest) {
    return this.request("/auth/password-reset/confirm", messageResponseSchema, { body });
  }

  private async request<S extends z.ZodType | null>(
    path: string,
    schema: S,
    options: { method?: "GET" | "POST"; body?: unknown; accessToken?: string },
  ): Promise<ApiResult<S extends z.ZodType ? z.output<S> : null>> {
    type Out = S extends z.ZodType ? z.output<S> : null;
    if (this.apiUrl === null) return { ok: false, error: NETWORK_ERROR };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response: Response;
    let text: string;
    try {
      const headers: Record<string, string> = { accept: "application/json" };
      if (options.body !== undefined) headers["content-type"] = "application/json";
      if (options.accessToken) headers.authorization = `Bearer ${options.accessToken}`;
      response = await this.fetchImpl(`${this.apiUrl}${path}`, {
        method: options.method ?? "POST",
        headers,
        cache: "no-store",
        signal: controller.signal,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      });
      text = await response.text();
    } catch {
      return { ok: false, error: NETWORK_ERROR };
    } finally {
      clearTimeout(timer);
    }

    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        return invalidResponse();
      }
    }

    if (!response.ok) {
      const parsed = apiErrorResponseSchema.safeParse(json);
      if (!parsed.success) {
        return {
          ok: false,
          error: {
            code: "internal_error",
            message: `Something went wrong (HTTP ${response.status}).`,
          },
        };
      }
      const retryAfter = Number(response.headers.get("retry-after"));
      return {
        ok: false,
        error: {
          ...parsed.data.error,
          ...(Number.isFinite(retryAfter) && retryAfter > 0
            ? { retryAfterSeconds: retryAfter }
            : {}),
        },
      };
    }

    if (schema === null) return { ok: true, data: null as Out };
    const parsed = schema.safeParse(json);
    if (!parsed.success) return invalidResponse();
    return { ok: true, data: parsed.data as Out };
  }
}

function invalidResponse(): { ok: false; error: ClientError } {
  return {
    ok: false,
    error: { code: "invalid_response", message: "Unexpected answer from the server. Try again." },
  };
}

/** Readable wait for a 429, e.g. "in 2 minutes". */
export function formatRetryAfter(seconds: number | undefined): string {
  if (!seconds) return "later";
  if (seconds < 60) return `in ${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.ceil(seconds / 60);
  return `in ${minutes} minute${minutes === 1 ? "" : "s"}`;
}

/** The message to show for an error, with the wait for rate limits. */
export function errorMessage(error: ClientError): string {
  if (error.code === "rate_limited") {
    return `Too many attempts. Please try again ${formatRetryAfter(error.retryAfterSeconds)}.`;
  }
  return error.message;
}

export type { AuthSessionResponse, MeResponse, MessageResponse, VerifyEmailResponse };
