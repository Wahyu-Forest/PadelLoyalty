import type { AuthSessionResponse } from "@padelloyalty/shared";
import type { TokenStore } from "./token-store";

export const user = {
  id: "0b6c5f0e-3c1a-4c1e-9a55-2d7f2b9d8e11",
  email: "ana@example.com",
  role: "member" as const,
  status: "active" as const,
  emailVerified: true,
  createdAt: "2026-11-18T10:00:00.000Z",
};

export function sessionBody(n: number, now = Date.now()): AuthSessionResponse {
  return {
    user,
    accessToken: `pla_${n}`,
    accessTokenExpiresAt: new Date(now + 15 * 60_000).toISOString(),
    refreshToken: `plr_${n}`,
    refreshTokenExpiresAt: new Date(now + 30 * 86_400_000).toISOString(),
  };
}

export function memoryStore(initial: string | null = null): TokenStore & { value: string | null } {
  return {
    value: initial,
    async get() {
      return this.value;
    },
    async set(token) {
      this.value = token;
    },
    async clear() {
      this.value = null;
    },
  };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}
