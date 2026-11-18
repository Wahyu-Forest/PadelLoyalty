"use client";

import { createContext, useContext, useEffect, useMemo, useSyncExternalStore } from "react";
import { AuthApi } from "@/lib/auth/api";
import { AuthSession, type AuthState, type Locks } from "@/lib/auth/session";
import { createTokenStore, REFRESH_TOKEN_KEY, type TokenStore } from "@/lib/auth/token-store";
import { apiUrl } from "@/lib/config";

interface AuthContextValue {
  state: AuthState;
  session: AuthSession;
  api: AuthApi;
}

/** Server render (static export) and first paint. */
const LOADING: AuthState = { status: "loading" };

const AuthContext = createContext<AuthContextValue | null>(null);

/** Defers to the platform store (Keychain/Keystore on native, localStorage on web) once loaded. */
function lazyStore(): TokenStore {
  let store: Promise<TokenStore> | undefined;
  const get = () => (store ??= createTokenStore());
  return {
    get: async () => (await get()).get(),
    set: async (token) => (await get()).set(token),
    clear: async () => (await get()).clear(),
  };
}

function webLocks(): Locks | null {
  if (typeof navigator === "undefined" || !("locks" in navigator) || !navigator.locks) return null;
  return {
    request: (name, callback) => navigator.locks.request(name, callback),
  };
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const value = useMemo(() => {
    const api = new AuthApi(apiUrl);
    return { api, session: new AuthSession(api, lazyStore(), webLocks()) };
  }, []);
  const { session } = value;
  const state = useSyncExternalStore(
    (onChange) => session.subscribe(onChange),
    () => session.getState(),
    () => LOADING,
  );

  useEffect(() => {
    if (session.getState().status === "loading") void session.start();

    // Another tab logged in or out.
    const onStorage = (event: StorageEvent) => {
      if (event.key === REFRESH_TOKEN_KEY || event.key === null) void session.syncFromStore();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [session]);

  return <AuthContext.Provider value={{ ...value, state }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside <AuthProvider>");
  return context;
}
