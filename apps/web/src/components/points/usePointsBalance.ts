"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { BalanceLoader, type BalanceState } from "@/lib/points/balance";
import { onPointsChanged } from "@/lib/points/events";
import { useAuth } from "../auth/AuthProvider";

const LOADING: BalanceState = { status: "loading" };

/**
 * The logged-in member's points balance (GET /points/balance, #6). Fetches on
 * mount and again when the app comes back to the foreground (window focus,
 * page visible) or when `notifyPointsChanged()` is called after an earn or
 * redeem. Use only for fully active accounts: the API refuses the others.
 */
export function usePointsBalance(userId: string) {
  const { api, session } = useAuth();

  const loader = useMemo(
    () =>
      new BalanceLoader(
        async () => {
          const token = await session.getAccessToken();
          if (!token) return null;
          const result = await api.pointsBalance(token);
          if (result.ok || result.error.code !== "unauthorized") return result;
          // Our access token was replaced (another tab refreshed the session,
          // which rotates it) or revoked: resume the session once and retry.
          // If the session is gone, the account panel shows the logged-out state.
          if ((await session.start()).status !== "authenticated") return null;
          const fresh = await session.getAccessToken();
          return fresh ? api.pointsBalance(fresh) : null;
        },
        (error) => {
          // The account stopped being active: let the account panel catch up.
          if (error.code === "account_not_active") void session.reloadUser();
        },
      ),
    // A new loader per member, so one member's balance never shows for another.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, session, userId],
  );

  const state = useSyncExternalStore(
    (onChange) => loader.subscribe(onChange),
    () => loader.getState(),
    () => LOADING,
  );

  useEffect(() => {
    void loader.load();
    const reload = () => void loader.load();
    const onVisibility = () => {
      if (document.visibilityState === "visible") reload();
    };
    window.addEventListener("focus", reload);
    document.addEventListener("visibilitychange", onVisibility);
    const unsubscribe = onPointsChanged(reload);
    return () => {
      window.removeEventListener("focus", reload);
      document.removeEventListener("visibilitychange", onVisibility);
      unsubscribe();
      loader.stop();
    };
  }, [loader]);

  return { state, reload: () => loader.load() };
}
