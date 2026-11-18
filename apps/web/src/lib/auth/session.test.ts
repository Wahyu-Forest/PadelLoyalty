import { describe, expect, it, vi } from "vitest";
import type { ApiResult, AuthApi } from "./api";
import { AuthSession, type Locks } from "./session";
import { memoryStore, sessionBody, user } from "./test-support";

type Session = ReturnType<typeof sessionBody>;

function fakeApi(overrides: Partial<Record<keyof AuthApi, unknown>> = {}) {
  let n = 1;
  const api = {
    logIn: vi.fn(async (): Promise<ApiResult<Session>> => ({ ok: true, data: sessionBody(n++) })),
    refresh: vi.fn(async (token: string): Promise<ApiResult<Session>> => {
      void token;
      return { ok: true, data: sessionBody(n++) };
    }),
    logOut: vi.fn(async () => ({ ok: true as const, data: null })),
    me: vi.fn(async () => ({ ok: true as const, data: { user } })),
    ...overrides,
  };
  return api as typeof api & AuthApi;
}

describe("AuthSession", () => {
  it("starts anonymous without a stored refresh token, without calling the API", async () => {
    const api = fakeApi();
    const session = new AuthSession(api, memoryStore());

    expect(await session.start()).toEqual({ status: "anonymous" });
    expect(api.refresh).not.toHaveBeenCalled();
  });

  it("logs in, stores only the refresh token and keeps the access token in memory", async () => {
    const store = memoryStore();
    const session = new AuthSession(fakeApi(), store);

    await session.logIn({ email: "ana@example.com", password: "pw" });

    expect(session.getState()).toEqual({ status: "authenticated", user });
    expect(store.value).toBe("plr_1");
    expect(await session.getAccessToken()).toBe("pla_1");
  });

  it("resumes a stored session on the next launch and stores the rotated token", async () => {
    const store = memoryStore("plr_old");
    const api = fakeApi();
    const session = new AuthSession(api, store);

    expect(await session.start()).toEqual({ status: "authenticated", user });
    expect(api.refresh).toHaveBeenCalledWith("plr_old");
    expect(store.value).toBe("plr_1");
  });

  it("forgets a rejected refresh token", async () => {
    const store = memoryStore("plr_old");
    const api = fakeApi({
      refresh: vi.fn(async () => ({
        ok: false,
        error: { code: "invalid_refresh_token", message: "ended" },
      })),
    });

    expect(await new AuthSession(api, store).start()).toEqual({ status: "anonymous" });
    expect(store.value).toBeNull();
  });

  it("keeps the stored token when the API is unreachable", async () => {
    const store = memoryStore("plr_old");
    const api = fakeApi({
      refresh: vi.fn(async () => ({
        ok: false,
        error: { code: "network_error", message: "down" },
      })),
    });

    expect((await new AuthSession(api, store).start()).status).toBe("unavailable");
    expect(store.value).toBe("plr_old");
  });

  it("refreshes an expired access token, once for concurrent callers", async () => {
    let now = Date.now();
    const api = fakeApi();
    const session = new AuthSession(api, memoryStore(), null, () => now);
    await session.logIn({ email: "a@b.co", password: "pw" });
    now += 15 * 60_000;

    const tokens = await Promise.all([session.getAccessToken(), session.getAccessToken()]);

    expect(tokens).toEqual(["pla_2", "pla_2"]);
    expect(api.refresh).toHaveBeenCalledTimes(1);
    expect(api.refresh).toHaveBeenCalledWith("plr_1");
  });

  it("refreshes inside the cross-tab lock, reading the token another tab stored", async () => {
    const store = memoryStore("plr_from_this_tab");
    const api = fakeApi();
    const locks: Locks = {
      async request(name, callback) {
        expect(name).toBe("padelloyalty-auth-refresh");
        store.value = "plr_rotated_by_other_tab"; // the other tab held the lock first
        return callback();
      },
    };

    await new AuthSession(api, store, locks).start();

    expect(api.refresh).toHaveBeenCalledWith("plr_rotated_by_other_tab");
  });

  it("logs out: clears the token, revokes it on the API, and becomes anonymous", async () => {
    const store = memoryStore();
    const api = fakeApi();
    const session = new AuthSession(api, store);
    await session.logIn({ email: "a@b.co", password: "pw" });
    const states: string[] = [];
    session.subscribe((s) => states.push(s.status));

    await session.logOut();

    expect(store.value).toBeNull();
    expect(api.logOut).toHaveBeenCalledWith("plr_1");
    expect(states).toEqual(["anonymous"]);
    expect(await session.getAccessToken()).toBeNull();
  });

  it("follows a logout in another tab", async () => {
    const store = memoryStore();
    const session = new AuthSession(fakeApi(), store);
    await session.logIn({ email: "a@b.co", password: "pw" });

    store.value = null;
    await session.syncFromStore();

    expect(session.getState()).toEqual({ status: "anonymous" });
  });
});
