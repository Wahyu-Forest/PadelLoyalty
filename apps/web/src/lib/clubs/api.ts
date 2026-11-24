import {
  adminClubDetailResponseSchema,
  adminClubListResponseSchema,
  clubResponseSchema,
  courtBlockListResponseSchema,
  courtResponseSchema,
  pricingResponseSchema,
  type ClubPricingInput,
  type CreateClubRequest,
  type CreateCourtBlocksRequest,
  type CreateCourtRequest,
  type UpdateClubRequest,
  type UpdateCourtRequest,
} from "@padelloyalty/shared";
import type { z } from "zod";
import type { ApiResult, AuthApi, HttpMethod } from "../auth/api";

const NOT_LOGGED_IN = {
  ok: false as const,
  error: { code: "unauthorized" as const, message: "Your session has ended. Please log in again." },
};

/** Staff club setup endpoints (docs/api/clubs.md), with the current access token. */
export class ClubsAdminApi {
  constructor(
    private readonly api: AuthApi,
    private readonly accessToken: () => Promise<string | null>,
  ) {}

  listClubs() {
    return this.call("GET", "/admin/clubs", adminClubListResponseSchema);
  }

  createClub(body: CreateClubRequest) {
    return this.call("POST", "/admin/clubs", clubResponseSchema, body);
  }

  getClub(clubId: string) {
    return this.call(
      "GET",
      `/admin/clubs/${encodeURIComponent(clubId)}`,
      adminClubDetailResponseSchema,
    );
  }

  updateClub(clubId: string, body: UpdateClubRequest) {
    return this.call(
      "PATCH",
      `/admin/clubs/${encodeURIComponent(clubId)}`,
      clubResponseSchema,
      body,
    );
  }

  createCourt(clubId: string, body: CreateCourtRequest) {
    return this.call(
      "POST",
      `/admin/clubs/${encodeURIComponent(clubId)}/courts`,
      courtResponseSchema,
      body,
    );
  }

  updateCourt(clubId: string, courtId: string, body: UpdateCourtRequest) {
    return this.call(
      "PATCH",
      `/admin/clubs/${encodeURIComponent(clubId)}/courts/${encodeURIComponent(courtId)}`,
      courtResponseSchema,
      body,
    );
  }

  setPricing(clubId: string, body: ClubPricingInput) {
    return this.call(
      "PUT",
      `/admin/clubs/${encodeURIComponent(clubId)}/pricing`,
      pricingResponseSchema,
      body,
    );
  }

  clearPricing(clubId: string) {
    return this.call("DELETE", `/admin/clubs/${encodeURIComponent(clubId)}/pricing`, null);
  }

  listBlocks(clubId: string) {
    return this.call(
      "GET",
      `/admin/clubs/${encodeURIComponent(clubId)}/blocks`,
      courtBlockListResponseSchema,
    );
  }

  createBlocks(clubId: string, body: CreateCourtBlocksRequest) {
    return this.call(
      "POST",
      `/admin/clubs/${encodeURIComponent(clubId)}/blocks`,
      courtBlockListResponseSchema,
      body,
    );
  }

  cancelBlock(clubId: string, blockId: string) {
    return this.call(
      "DELETE",
      `/admin/clubs/${encodeURIComponent(clubId)}/blocks/${encodeURIComponent(blockId)}`,
      null,
    );
  }

  private async call<S extends z.ZodType | null>(
    method: HttpMethod,
    path: string,
    schema: S,
    body?: unknown,
  ): Promise<ApiResult<S extends z.ZodType ? z.output<S> : null>> {
    const accessToken = await this.accessToken();
    if (!accessToken) return NOT_LOGGED_IN;
    return this.api.request(path, schema, {
      method,
      accessToken,
      ...(body !== undefined ? { body } : {}),
    });
  }
}
