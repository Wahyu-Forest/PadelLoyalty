import {
  clubPricingSchema,
  createClubRequestSchema,
  createCourtBlocksRequestSchemaIn,
  createCourtRequestSchema,
  listCourtBlocksQuerySchema,
  publicCourtBlocksQuerySchema,
  updateClubRequestSchema,
  updateCourtRequestSchema,
  type AdminClubDetailResponse,
  type AdminClubListResponse,
  type ClubResponse,
  type CourtBlockListResponse,
  type CourtResponse,
  type PricingResponse,
  type PublicClubDetailResponse,
  type PublicClubListResponse,
  type PublicCourtBlockListResponse,
} from "@padelloyalty/shared";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireAuth } from "../auth/routes.js";
import type { AuthService } from "../auth/service.js";
import type { UserRow } from "../db/schema.js";
import { parseBody } from "../http/errors.js";
import { ClubAccessPolicy, forbidden, requireClubAdmin } from "./access.js";
import { notFound, toClub, toCourt, toCourtBlock, type ClubService } from "./service.js";

const uuid = z.uuid();

/** A UUID path parameter; anything else is a 404, like an unknown id. */
function idParam(request: FastifyRequest, name: string): string {
  const value = (request.params as Record<string, string | undefined>)[name];
  const parsed = uuid.safeParse(value);
  if (!parsed.success) throw notFound();
  return parsed.data;
}

function caller(request: FastifyRequest): UserRow {
  const user = request.auth?.user;
  if (!user) throw forbidden();
  return user;
}

export interface ClubRoutesOptions {
  clubs: ClubService;
  auth: AuthService;
  policy?: ClubAccessPolicy;
}

/** Public reads for members' apps and booking (#23). No auth. */
const publicClubRoutes: FastifyPluginAsync<{ clubs: ClubService }> = async (app, { clubs }) => {
  app.get("/clubs", async () => {
    const body: PublicClubListResponse = {
      clubs: (await clubs.listActiveClubs()).map(toClub),
    };
    return body;
  });

  app.get("/clubs/:clubId", async (request) => {
    const club = await clubs.getActiveClub(idParam(request, "clubId"));
    if (!club) throw notFound();
    const body: PublicClubDetailResponse = {
      club: toClub(club),
      courts: (await clubs.listCourts(club.id, { activeOnly: true })).map(toCourt),
      pricing: club.pricing,
    };
    return body;
  });

  app.get("/clubs/:clubId/blocks", async (request) => {
    const clubId = idParam(request, "clubId");
    const query = parseBody(publicCourtBlocksQuerySchema, request.query);
    const club = await clubs.getActiveClub(clubId);
    if (!club) throw notFound();
    const body: PublicCourtBlockListResponse = {
      blocks: await clubs.listPublicBlocks(club.id, new Date(query.from), new Date(query.to)),
    };
    return body;
  });
};

/** Club setup for staff (#56). Every route: Bearer token, then `ClubAccessPolicy`. */
const adminClubRoutes: FastifyPluginAsync<ClubRoutesOptions> = async (app, options) => {
  const { clubs } = options;
  const policy = options.policy ?? new ClubAccessPolicy();
  app.addHook("preHandler", requireAuth(options.auth));
  app.addHook("preHandler", requireClubAdmin(policy));

  /** The club in the path, if the caller may manage it (403) and it exists (404). */
  const managedClub = async (request: FastifyRequest) => {
    const clubId = idParam(request, "clubId");
    if (!policy.canManageClub(caller(request), clubId)) throw forbidden();
    return clubs.requireClub(clubId);
  };

  const logAction = (request: FastifyRequest, action: string, detail: Record<string, unknown>) =>
    request.log.info({ staffUserId: caller(request).id, action, ...detail }, "staff action");

  app.get("/admin/clubs", async (request) => {
    const body: AdminClubListResponse = {
      clubs: await clubs.listClubsForAdmin(policy.manageableClubIds(caller(request))),
    };
    return body;
  });

  app.post("/admin/clubs", async (request, reply) => {
    if (!policy.canCreateClubs(caller(request))) throw forbidden();
    const input = parseBody(createClubRequestSchema, request.body);
    const club = await clubs.createClub(input);
    logAction(request, "club.create", { clubId: club.id });
    const body: ClubResponse = { club: toClub(club) };
    return reply.code(201).send(body);
  });

  app.get("/admin/clubs/:clubId", async (request) => {
    const club = await managedClub(request);
    const body: AdminClubDetailResponse = {
      club: toClub(club),
      courts: (await clubs.listCourts(club.id)).map(toCourt),
      pricing: club.pricing,
    };
    return body;
  });

  app.patch("/admin/clubs/:clubId", async (request) => {
    const club = await managedClub(request);
    const patch = parseBody(updateClubRequestSchema, request.body);
    const updated = await clubs.updateClub(club.id, patch);
    logAction(request, "club.update", { clubId: club.id, fields: Object.keys(patch) });
    const body: ClubResponse = { club: toClub(updated) };
    return body;
  });

  app.post("/admin/clubs/:clubId/courts", async (request, reply) => {
    const club = await managedClub(request);
    const input = parseBody(createCourtRequestSchema, request.body);
    const court = await clubs.createCourt(club.id, input);
    logAction(request, "court.create", { clubId: club.id, courtId: court.id });
    const body: CourtResponse = { court: toCourt(court) };
    return reply.code(201).send(body);
  });

  app.patch("/admin/clubs/:clubId/courts/:courtId", async (request) => {
    const club = await managedClub(request);
    const courtId = idParam(request, "courtId");
    const patch = parseBody(updateCourtRequestSchema, request.body);
    const court = await clubs.updateCourt(club.id, courtId, patch);
    logAction(request, "court.update", { clubId: club.id, courtId, fields: Object.keys(patch) });
    const body: CourtResponse = { court: toCourt(court) };
    return body;
  });

  app.put("/admin/clubs/:clubId/pricing", async (request) => {
    const club = await managedClub(request);
    const pricing = parseBody(clubPricingSchema, request.body);
    const saved = await clubs.setPricing(club.id, pricing);
    logAction(request, "pricing.set", { clubId: club.id });
    const body: PricingResponse = { pricing: saved };
    return body;
  });

  app.delete("/admin/clubs/:clubId/pricing", async (request, reply) => {
    const club = await managedClub(request);
    await clubs.clearPricing(club.id);
    logAction(request, "pricing.clear", { clubId: club.id });
    return reply.code(204).send();
  });

  app.get("/admin/clubs/:clubId/blocks", async (request) => {
    const club = await managedClub(request);
    const query = parseBody(listCourtBlocksQuerySchema, request.query);
    const rows = await clubs.listBlocks(club.id, {
      ...(query.from ? { from: new Date(query.from) } : {}),
      ...(query.to ? { to: new Date(query.to) } : {}),
      ...(query.courtId ? { courtId: query.courtId } : {}),
      includeCancelled: query.includeCancelled ?? false,
    });
    const body: CourtBlockListResponse = {
      blocks: rows.map((row) => toCourtBlock(row, club.timeZone)),
    };
    return body;
  });

  app.post("/admin/clubs/:clubId/blocks", async (request, reply) => {
    const club = await managedClub(request);
    const input = parseBody(createCourtBlocksRequestSchemaIn(club.timeZone), request.body);
    const rows = await clubs.createBlocks(club.id, input, caller(request).id);
    logAction(request, "block.create", { clubId: club.id, blockIds: rows.map((r) => r.id) });
    const body: CourtBlockListResponse = {
      blocks: rows.map((row) => toCourtBlock(row, club.timeZone)),
    };
    return reply.code(201).send(body);
  });

  app.delete("/admin/clubs/:clubId/blocks/:blockId", async (request, reply) => {
    const club = await managedClub(request);
    const blockId = idParam(request, "blockId");
    await clubs.cancelBlock(club.id, blockId, caller(request).id);
    logAction(request, "block.cancel", { clubId: club.id, blockId });
    return reply.code(204).send();
  });
};

export const clubRoutes: FastifyPluginAsync<ClubRoutesOptions> = async (app, options) => {
  await app.register(publicClubRoutes, { clubs: options.clubs });
  await app.register(adminClubRoutes, options);
};
