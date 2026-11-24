/**
 * In-browser stand-in for the club setup API (docs/api/clubs.md, #56),
 * installed with Playwright routes on top of `FakeAuthApi` (which supplies the
 * logged-in user). Requests are validated and responses built with the shared
 * Zod schemas, so the fake cannot drift from the contract without failing.
 * The real API is covered by apps/api/test/clubs.db.test.ts.
 */
import {
  adminClubDetailResponseSchema,
  adminClubListResponseSchema,
  canSetUpClubs,
  clubPricingSchema,
  clubResponseSchema,
  courtBlockListResponseSchema,
  courtResponseSchema,
  createClubRequestSchema,
  createCourtBlocksRequestSchemaIn,
  createCourtRequestSchema,
  pricingResponseSchema,
  toLocalDateTime,
  updateClubRequestSchema,
  updateCourtRequestSchema,
  type ApiErrorCode,
  type Club,
  type ClubPricing,
  type Court,
  type CourtBlock,
} from "@padelloyalty/shared";
import type { Page, Route } from "@playwright/test";
import { z } from "zod";
import { API_URL, type FakeAuthApi } from "./fake-auth-api";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
};

class Reply extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`HTTP ${status}`);
  }
}

const fail = (status: number, code: ApiErrorCode, message: string, fieldErrors?: object) =>
  new Reply(status, { error: { code, message, ...(fieldErrors ? { fieldErrors } : {}) } });

interface StoredClub {
  club: Club;
  pricing: ClubPricing | null;
  courts: Court[];
  blocks: CourtBlock[];
}

export class FakeClubsApi {
  readonly clubs = new Map<string, StoredClub>();
  /** Every call the app made, e.g. "PATCH /admin/clubs/…". */
  readonly calls: string[] = [];
  /** "Now" for the default blocks window. */
  now = new Date("2026-11-24T12:00:00Z");

  constructor(private readonly auth: FakeAuthApi) {}

  async install(page: Page): Promise<void> {
    // Registered after FakeAuthApi, so these routes take priority for /admin/clubs.
    await page.route(`${API_URL}/admin/clubs**`, (route) => this.handle(route));
  }

  /** Seeds a club directly. */
  addClub(fields: Partial<Club> & Pick<Club, "name">): StoredClub {
    const at = new Date().toISOString();
    const club: Club = {
      id: crypto.randomUUID(),
      address: "1 Test Street",
      timeZone: "Europe/London",
      currency: "GBP",
      active: true,
      openingHours: {
        mon: { opens: "07:00", closes: "23:00" },
        tue: { opens: "07:00", closes: "23:00" },
        wed: { opens: "07:00", closes: "23:00" },
        thu: { opens: "07:00", closes: "23:00" },
        fri: { opens: "07:00", closes: "23:00" },
        sat: null,
        sun: null,
      },
      createdAt: at,
      updatedAt: at,
      ...fields,
    };
    const stored = { club, pricing: null, courts: [], blocks: [] };
    this.clubs.set(club.id, stored);
    return stored;
  }

  private async handle(route: Route): Promise<void> {
    const request = route.request();
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    const path = new URL(request.url()).pathname;
    this.calls.push(`${request.method()} ${path}`);
    let body: unknown = {};
    try {
      body = request.postDataJSON() ?? {};
    } catch {
      body = {};
    }
    let status = 200;
    let response: unknown;
    try {
      [status, response] = this.respond(request.method(), path, body, request.headers());
    } catch (error) {
      if (!(error instanceof Reply)) throw error;
      status = error.status;
      response = error.body;
    }
    return route.fulfill({
      status,
      headers: CORS,
      contentType: "application/json",
      body: status === 204 ? "" : JSON.stringify(response),
    });
  }

  private respond(
    method: string,
    path: string,
    body: unknown,
    headers: Record<string, string>,
  ): [number, unknown] {
    const account = this.auth.authenticated(headers);
    if (!account) throw fail(401, "unauthorized", "You need to log in to do that.");
    if (!canSetUpClubs(account.user.role)) {
      throw fail(403, "forbidden", "You don't have permission to do that.");
    }

    const parse = <T extends z.ZodType>(schema: T): z.output<T> => {
      const result = schema.safeParse(body);
      if (!result.success) {
        throw fail(
          400,
          "validation_error",
          "Some fields are missing or invalid.",
          z.flattenError(result.error).fieldErrors,
        );
      }
      return result.data;
    };
    const touch = (stored: StoredClub) => {
      stored.club = { ...stored.club, updatedAt: new Date().toISOString() };
    };

    const parts = path
      .replace(/^\/admin\/clubs\/?/, "")
      .split("/")
      .filter(Boolean);
    const [clubId, section, itemId] = parts;

    if (!clubId) {
      if (method === "GET") {
        const clubs = [...this.clubs.values()]
          .sort((a, b) => a.club.name.localeCompare(b.club.name))
          .map((s) => ({
            ...s.club,
            courtCount: s.courts.length,
            activeCourtCount: s.courts.filter((c) => c.active).length,
            hasPricing: s.pricing !== null,
          }));
        return [200, adminClubListResponseSchema.parse({ clubs })];
      }
      if (method === "POST") {
        const input = parse(createClubRequestSchema);
        this.assertClubNameFree(input.name);
        const stored = this.addClub(input);
        return [201, clubResponseSchema.parse({ club: stored.club })];
      }
    }

    const stored = clubId ? this.clubs.get(clubId) : undefined;
    if (!stored) throw fail(404, "not_found", "Not found.");

    if (!section) {
      if (method === "GET") {
        return [
          200,
          adminClubDetailResponseSchema.parse({
            club: stored.club,
            courts: [...stored.courts].sort((a, b) => a.name.localeCompare(b.name)),
            pricing: stored.pricing,
          }),
        ];
      }
      if (method === "PATCH") {
        const patch = parse(updateClubRequestSchema);
        if (patch.name !== undefined) this.assertClubNameFree(patch.name, stored.club.id);
        if (patch.currency && patch.currency !== stored.club.currency && stored.pricing) {
          throw fail(
            409,
            "currency_locked",
            "Remove this club's prices before changing the currency.",
          );
        }
        stored.club = { ...stored.club, ...patch };
        touch(stored);
        return [200, clubResponseSchema.parse({ club: stored.club })];
      }
    }

    if (section === "courts") {
      const nameTaken = (name: string, except?: string) =>
        stored.courts.some((c) => c.id !== except && c.name.toLowerCase() === name.toLowerCase());
      if (method === "POST" && !itemId) {
        const input = parse(createCourtRequestSchema);
        if (nameTaken(input.name))
          throw fail(409, "court_name_taken", "This club already has a court with this name.");
        const at = new Date().toISOString();
        const court: Court = {
          id: crypto.randomUUID(),
          clubId: stored.club.id,
          ...input,
          createdAt: at,
          updatedAt: at,
        };
        stored.courts.push(court);
        return [201, courtResponseSchema.parse({ court })];
      }
      if (method === "PATCH" && itemId) {
        const index = stored.courts.findIndex((c) => c.id === itemId);
        if (index < 0) throw fail(404, "not_found", "Not found.");
        const patch = parse(updateCourtRequestSchema);
        if (patch.name !== undefined && nameTaken(patch.name, itemId)) {
          throw fail(409, "court_name_taken", "This club already has a court with this name.");
        }
        const court = { ...stored.courts[index]!, ...patch, updatedAt: new Date().toISOString() };
        stored.courts[index] = court;
        return [200, courtResponseSchema.parse({ court })];
      }
    }

    if (section === "pricing") {
      if (method === "PUT") {
        stored.pricing = parse(clubPricingSchema);
        touch(stored);
        return [200, pricingResponseSchema.parse({ pricing: stored.pricing })];
      }
      if (method === "DELETE") {
        stored.pricing = null;
        touch(stored);
        return [204, null];
      }
    }

    if (section === "blocks") {
      if (method === "GET") {
        const blocks = stored.blocks
          .filter((b) => !b.cancelledAt && Date.parse(b.endsAt) > this.now.getTime())
          .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
        return [200, courtBlockListResponseSchema.parse({ blocks })];
      }
      if (method === "POST") {
        const input = parse(createCourtBlocksRequestSchemaIn(stored.club.timeZone));
        if (!input.courtIds.every((id) => stored.courts.some((c) => c.id === id))) {
          throw fail(400, "validation_error", "Some fields are missing or invalid.", {
            courtIds: ["Choose courts of this club"],
          });
        }
        const created = input.courtIds.map((courtId) => ({
          id: crypto.randomUUID(),
          clubId: stored.club.id,
          courtId,
          reason: input.reason,
          note: input.note,
          startsAt: input.startsAt.toISOString(),
          endsAt: input.endsAt.toISOString(),
          startsLocal: toLocalDateTime(input.startsAt, stored.club.timeZone),
          endsLocal: toLocalDateTime(input.endsAt, stored.club.timeZone),
          createdAt: new Date().toISOString(),
          cancelledAt: null,
        }));
        stored.blocks.push(...created);
        return [201, courtBlockListResponseSchema.parse({ blocks: created })];
      }
      if (method === "DELETE" && itemId) {
        const block = stored.blocks.find((b) => b.id === itemId);
        if (!block) throw fail(404, "not_found", "Not found.");
        block.cancelledAt ??= new Date().toISOString();
        return [204, null];
      }
    }

    throw fail(404, "not_found", "Not found.");
  }

  private assertClubNameFree(name: string, except?: string) {
    for (const { club } of this.clubs.values()) {
      if (club.id !== except && club.name.toLowerCase() === name.toLowerCase()) {
        throw fail(409, "club_name_taken", "Another club already has this name.");
      }
    }
  }
}
