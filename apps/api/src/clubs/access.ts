import { canSetUpClubs, isAccountFullyActive } from "@padelloyalty/shared";
import type { preHandlerAsyncHookHandler } from "fastify";
import type { UserRow } from "../db/schema.js";
import { ApiError } from "../http/errors.js";

type Caller = Pick<UserRow, "id" | "role" | "status">;

/**
 * Who may manage which club (#56). The one place club access is decided;
 * every `/admin/clubs` route goes through it.
 *
 * Today only admins pass, and they manage every club. Club managers scoped
 * to one club come with #39: give users a club assignment, then let
 * `canUseClubAdmin` accept `club_manager`, and `canManageClub` /
 * `manageableClubIds` answer from the assignment. Creating clubs stays admin-only.
 */
export class ClubAccessPolicy {
  /** May reach the `/admin/clubs` endpoints at all. */
  canUseClubAdmin(user: Caller): boolean {
    return canSetUpClubs(user.role);
  }

  canCreateClubs(user: Caller): boolean {
    return user.role === "admin";
  }

  canManageClub(user: Caller, _clubId: string): boolean {
    return user.role === "admin";
  }

  /** `"all"` for admins; the club ids a scoped manager may see (none until #39). */
  manageableClubIds(user: Caller): "all" | string[] {
    return user.role === "admin" ? "all" : [];
  }
}

export const forbidden = () =>
  new ApiError(403, "forbidden", "You don't have permission to do that.");

/**
 * preHandler, after `requireAuth`: `403 forbidden` unless the role may use
 * club admin, then `403 account_not_active` unless the account is active.
 */
export function requireClubAdmin(policy: ClubAccessPolicy): preHandlerAsyncHookHandler {
  return async (request) => {
    const user = request.auth?.user;
    if (!user) throw new ApiError(401, "unauthorized", "You need to log in to do that.");
    if (!policy.canUseClubAdmin(user)) throw forbidden();
    if (!isAccountFullyActive(user.status)) {
      throw new ApiError(403, "account_not_active", "Your account is not active.");
    }
  };
}
