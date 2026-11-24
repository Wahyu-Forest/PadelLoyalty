/**
 * Where the refresh token is kept between app launches. The short-lived
 * access token is never persisted; it lives in memory only.
 *
 * - iOS / Android (Capacitor): the Keychain / Android Keystore, through
 *   @aparajita/capacitor-secure-storage.
 * - Web: localStorage. The API is on another origin than GitHub Pages, so an
 *   httpOnly cookie would be a third-party cookie, which Safari and Chrome
 *   block. See docs/ARCHITECTURE.md#authentication for the trade-off.
 */
export interface TokenStore {
  get(): Promise<string | null>;
  set(token: string): Promise<void>;
  clear(): Promise<void>;
}

export const REFRESH_TOKEN_KEY = "padelloyalty.refreshToken";

export function localStorageTokenStore(storage: Storage = window.localStorage): TokenStore {
  return {
    async get() {
      try {
        return storage.getItem(REFRESH_TOKEN_KEY);
      } catch {
        return null; // Storage disabled (e.g. some private modes).
      }
    },
    async set(token) {
      try {
        storage.setItem(REFRESH_TOKEN_KEY, token);
      } catch {
        // Without storage the session lasts until the page is closed.
      }
    },
    async clear() {
      try {
        storage.removeItem(REFRESH_TOKEN_KEY);
      } catch {
        // Nothing stored.
      }
    },
  };
}

/** Keychain (iOS) / Keystore (Android). Loaded lazily so the web build doesn't pay for it. */
export function secureStorageTokenStore(): TokenStore {
  const plugin = import("@aparajita/capacitor-secure-storage").then(async ({ SecureStorage }) => {
    await SecureStorage.setKeyPrefix("padelloyalty_");
    return SecureStorage;
  });
  return {
    async get() {
      return (await plugin).getItem(REFRESH_TOKEN_KEY);
    },
    async set(token) {
      await (await plugin).setItem(REFRESH_TOKEN_KEY, token);
    },
    async clear() {
      await (await plugin).removeItem(REFRESH_TOKEN_KEY);
    },
  };
}

export async function createTokenStore(): Promise<TokenStore> {
  const { Capacitor } = await import("@capacitor/core");
  return Capacitor.isNativePlatform() ? secureStorageTokenStore() : localStorageTokenStore();
}
