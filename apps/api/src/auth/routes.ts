import {
  consentDecisionRequestSchema,
  consentRequestRequestSchema,
  consentReviewRequestSchema,
  isAccountFullyActive,
  logInRequestSchema,
  logOutRequestSchema,
  passwordResetConfirmRequestSchema,
  passwordResetRequestSchema,
  refreshRequestSchema,
  resendVerificationRequestSchema,
  signUpRequestSchemaOn,
  verifyEmailRequestSchema,
  type AuthSessionResponse,
  type ConsentDecisionResponse,
  type ConsentReviewResponse,
  type ConsentStatusResponse,
  type MeResponse,
  type MessageResponse,
  type VerifyEmailResponse,
} from "@padelloyalty/shared";
import type { FastifyPluginAsync, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import { ApiError, parseBody } from "../http/errors.js";
import { MESSAGES, toAuthUser, type AuthenticatedSession, type AuthService } from "./service.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Set by `requireAuth` for authenticated routes. */
    auth?: AuthenticatedSession;
  }
}

function context(request: FastifyRequest) {
  const userAgent = request.headers["user-agent"];
  return { ip: request.ip, ...(userAgent ? { userAgent } : {}) };
}

const unauthorized = () => new ApiError(401, "unauthorized", "You need to log in to do that.");

/**
 * preHandler for routes that need a logged-in user: checks the
 * `Authorization: Bearer <accessToken>` header and sets `request.auth`.
 * It does not check the account status; use `requireActiveAccount` for
 * features that need a fully active account.
 */
export function requireAuth(service: AuthService): preHandlerAsyncHookHandler {
  return async (request) => {
    request.auth = await authenticateRequest(service, request);
  };
}

async function authenticateRequest(
  service: AuthService,
  request: FastifyRequest,
): Promise<AuthenticatedSession> {
  const header = request.headers.authorization ?? "";
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  if (!match?.[1]) throw unauthorized();
  const session = await service.authenticate(match[1]);
  if (!session) throw unauthorized();
  return session;
}

const notActiveMessages = {
  pending_verification: "Verify your email to start using Soul Padel.",
  pending_consent:
    "Your account is waiting for your parent or guardian's consent. You can use Soul Padel once they confirm.",
} as const;

/**
 * preHandler for member features (booking, earning points, ...) that need a
 * fully active account (#3). Authenticates like `requireAuth`, then answers
 * `403 account_not_active` unless `isAccountFullyActive(user.status)`.
 */
export function requireActiveAccount(service: AuthService): preHandlerAsyncHookHandler {
  return async (request) => {
    request.auth = await authenticateRequest(service, request);
    const { status } = request.auth.user;
    if (!isAccountFullyActive(status)) {
      throw new ApiError(
        403,
        "account_not_active",
        status === "active" ? "Your account is not active." : notActiveMessages[status],
      );
    }
  };
}

export const authRoutes: FastifyPluginAsync<{ service: AuthService }> = async (
  app,
  { service },
) => {
  app.post("/auth/signup", async (request, reply) => {
    const signUp = parseBody(signUpRequestSchemaOn(service.consent.today()), request.body);
    await service.signUp(signUp, context(request));
    const body: MessageResponse = { message: MESSAGES.signUp };
    return reply.code(202).send(body);
  });

  app.post("/auth/verify-email", async (request) => {
    const { token } = parseBody(verifyEmailRequestSchema, request.body);
    const accountStatus = await service.verifyEmail(token, context(request));
    const body: VerifyEmailResponse = {
      message:
        accountStatus === "pending_consent"
          ? MESSAGES.emailVerifiedPendingConsent
          : MESSAGES.emailVerified,
      accountStatus,
    };
    return body;
  });

  app.post("/auth/verify-email/resend", async (request, reply) => {
    const { email } = parseBody(resendVerificationRequestSchema, request.body);
    await service.resendVerification(email, context(request));
    const body: MessageResponse = { message: MESSAGES.resendVerification };
    return reply.code(202).send(body);
  });

  app.post("/auth/login", async (request) => {
    const { email, password } = parseBody(logInRequestSchema, request.body);
    const body: AuthSessionResponse = await service.logIn(email, password, context(request));
    return body;
  });

  app.post("/auth/refresh", async (request) => {
    const { refreshToken } = parseBody(refreshRequestSchema, request.body);
    const body: AuthSessionResponse = await service.refresh(refreshToken);
    return body;
  });

  app.post("/auth/logout", async (request, reply) => {
    const { refreshToken } = parseBody(logOutRequestSchema, request.body);
    await service.logOut(refreshToken);
    return reply.code(204).send();
  });

  app.get("/auth/me", { preHandler: requireAuth(service) }, async (request) => {
    if (!request.auth) throw unauthorized();
    const body: MeResponse = { user: toAuthUser(request.auth.user) };
    return body;
  });

  app.post("/auth/password-reset/request", async (request, reply) => {
    const { email } = parseBody(passwordResetRequestSchema, request.body);
    await service.requestPasswordReset(email, context(request));
    const body: MessageResponse = { message: MESSAGES.passwordResetRequested };
    return reply.code(202).send(body);
  });

  app.post("/auth/password-reset/confirm", async (request) => {
    const { token, password } = parseBody(passwordResetConfirmRequestSchema, request.body);
    await service.confirmPasswordReset(token, password, context(request));
    const body: MessageResponse = { message: MESSAGES.passwordReset };
    return body;
  });

  // Guardian consent (#3), see docs/api/consent.md.

  app.get("/auth/consent", { preHandler: requireAuth(service) }, async (request) => {
    if (!request.auth) throw unauthorized();
    const body: ConsentStatusResponse = await service.consent.status(request.auth.user);
    return body;
  });

  app.post("/auth/consent/request", { preHandler: requireAuth(service) }, async (request) => {
    if (!request.auth) throw unauthorized();
    const { guardianEmail } = parseBody(consentRequestRequestSchema, request.body);
    const body: ConsentStatusResponse = await service.consent.request(
      request.auth.user,
      guardianEmail,
      context(request),
    );
    return body;
  });

  app.post("/auth/consent/review", async (request) => {
    const { token } = parseBody(consentReviewRequestSchema, request.body);
    const body: ConsentReviewResponse = await service.consent.review(token, context(request));
    return body;
  });

  app.post("/auth/consent/decision", async (request) => {
    const { token, decision } = parseBody(consentDecisionRequestSchema, request.body);
    const body: ConsentDecisionResponse = await service.consent.decide(
      token,
      decision,
      context(request),
    );
    return body;
  });
};
