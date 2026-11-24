"use client";

import { useMemo } from "react";
import { ClubsAdminApi } from "@/lib/clubs/api";
import { useAuth } from "../auth/AuthProvider";

export function useClubsApi(): ClubsAdminApi {
  const { api, session } = useAuth();
  return useMemo(() => new ClubsAdminApi(api, () => session.getAccessToken()), [api, session]);
}
