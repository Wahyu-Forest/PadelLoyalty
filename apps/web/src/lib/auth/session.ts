import type { AuthSessionResponse, AuthUser, LogInRequest } from "@padelloyalty/shared";
import type { AuthApi, ApiResult, ClientError } from "./api";
import type { TokenStore } from "./token-store";

export type AuthState =
  | { status: "loading" }
  | { status: "anonymous" }
  | { status: "authenticated"; user: AuthUser }
  /** A session is stored but the API could not be reached to resume it. */
  | { status: "unavailable"; error: ClientError };

type Listener = (state: AuthState) => void;

/** Refresh this long before the access token expires, to allow for clock skew. */
const EXPIRY_MARGIN_MS = 30_000;
const REFRESH_LOCK = "padelloyalty-auth-refresh";

/** Subset of the Web Locks API, which serialises refreshes across browser tabs. */
export interface Locks {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

/**
 * Client-side session: keeps the access token in memory, the refresh token in
 * the platform's TokenStore, and refreshes when needed. Refresh tokens rotate
 * and the API revokes a session when an old one is reused, so refreshes are
 * serialised (across tabs too, with Web Locks) and always use the latest
 * stored token.
 */
export class AuthSession {
  private state: AuthState = { status: "loading" };
  private readonly listeners = new Set<Listener>();
  private accessToken: { value: string; expiresAt: number } | null = null;
  private inflightRefresh: Promise<ApiResult<AuthSessionResponse>> | null = null;

  constructor(
    private readonly api: AuthApi,
    private readonly store: TokenStore,
    private readonly locks: Locks | null = null,
    private readonly now: () => number = Date.now,
  ) {}

  getState(): AuthState {
    return this.state;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Resumes a stored session (app launch / page load). */
  async start(): Promise<AuthState> {
    const stored = await this.store.get();
    if (!stored) return this.setState({ status: "anonymous" });
    return this.applyRefresh(await this.refresh());
  }

  async logIn(credentials: LogInRequest): Promise<ApiResult<AuthUser>> {
    const result = await this.api.logIn(credentials);
    if (!result.ok) return result;
    await this.acceptSession(result.data);
    return { ok: true, data: result.data.user };
  }

  /** Ends the session on the server (best effort) and forgets it locally. */
  async logOut(): Promise<void> {
    const stored = await this.store.get();
    this.accessToken = null;
    await this.store.clear();
    this.setState({ status: "anonymous" });
    if (stored) await this.api.logOut(stored);
  }

  /** A valid access token, refreshing first if needed; null when logged out. */
  async getAccessToken(): Promise<string | null> {
    if (this.accessToken && this.accessToken.expiresAt - EXPIRY_MARGIN_MS > this.now()) {
      return this.accessToken.value;
    }
    const result = await this.refresh();
    this.applyRefresh(result);
    return result.ok ? result.data.accessToken : null;
  }

  /** Reloads the user (e.g. after verifying the email in this browser). */
  async reloadUser(): Promise<void> {
    const token = await this.getAccessToken();
    if (!token) return;
    const result = await this.api.me(token);
    if (result.ok) this.setState({ status: "authenticated", user: result.data.user });
  }

  /** Another tab logged out or in: follow it. */
  async syncFromStore(): Promise<void> {
    const stored = await this.store.get();
    if (!stored && this.state.status !== "anonymous") {
      this.accessToken = null;
      this.setState({ status: "anonymous" });
    } else if (stored && this.state.status === "anonymous") {
      await this.start();
    }
  }

  private refresh(): Promise<ApiResult<AuthSessionResponse>> {
    // One refresh at a time in this tab...
    this.inflightRefresh ??= this.refreshLocked().finally(() => {
      this.inflightRefresh = null;
    });
    return this.inflightRefresh;
  }

  private async refreshLocked(): Promise<ApiResult<AuthSessionResponse>> {
    // ...and across tabs. The token is read inside the lock, so a tab that
    // waited uses the token the previous holder just stored.
    const run = async (): Promise<ApiResult<AuthSessionResponse>> => {
      const stored = await this.store.get();
      if (!stored) {
        return { ok: false, error: { code: "invalid_refresh_token", message: "Not logged in." } };
      }
      const result = await this.api.refresh(stored);
      if (result.ok) await this.acceptSession(result.data);
      else if (result.error.code === "invalid_refresh_token") await this.store.clear();
      return result;
    };
    return this.locks ? this.locks.request(REFRESH_LOCK, run) : run();
  }

  private applyRefresh(result: ApiResult<AuthSessionResponse>): AuthState {
    if (result.ok) return this.state;
    this.accessToken = null;
    if (result.error.code === "network_error") {
      return this.setState({ status: "unavailable", error: result.error });
    }
    // Rejected, expired or revoked: the stored session is gone.
    return this.setState({ status: "anonymous" });
  }

  private async acceptSession(session: AuthSessionResponse): Promise<void> {
    await this.store.set(session.refreshToken);
    this.accessToken = {
      value: session.accessToken,
      expiresAt: Date.parse(session.accessTokenExpiresAt),
    };
    this.setState({ status: "authenticated", user: session.user });
  }

  private setState(state: AuthState): AuthState {
    this.state = state;
    for (const listener of this.listeners) listener(state);
    return state;
  }
}
