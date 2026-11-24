import type { PointsBalanceResponse } from "@padelloyalty/shared";
import type { FastifyPluginAsync } from "fastify";
import { requireActiveAccount } from "../auth/routes.js";
import type { AuthService } from "../auth/service.js";
import type { PointsLedger } from "./ledger.js";

/**
 * Member points endpoints (#6). Contract: docs/api/points.md. Read-only:
 * points are written by server features through `PointsLedger`, never by a
 * public endpoint here.
 */
export const pointsRoutes: FastifyPluginAsync<{
  authService: AuthService;
  ledger: PointsLedger;
  now: () => Date;
}> = async (app, { authService, ledger, now }) => {
  app.get(
    "/points/balance",
    { preHandler: requireActiveAccount(authService) },
    async (request, reply) => {
      // requireActiveAccount always sets request.auth.
      const userId = request.auth!.user.id;
      const body: PointsBalanceResponse = {
        balance: await ledger.balance(userId),
        asOf: now().toISOString(),
      };
      return reply.header("cache-control", "no-store").send(body);
    },
  );
};
