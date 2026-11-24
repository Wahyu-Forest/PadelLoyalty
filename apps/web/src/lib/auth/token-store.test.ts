import { describe, expect, it } from "vitest";
import { localStorageTokenStore, REFRESH_TOKEN_KEY } from "./token-store";

function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k) => map.get(k) ?? null,
    key: (i) => [...map.keys()][i] ?? null,
    removeItem: (k) => void map.delete(k),
    setItem: (k, v) => void map.set(k, v),
  };
}

describe("localStorageTokenStore", () => {
  it("stores, reads and clears the refresh token under one key", async () => {
    const storage = fakeStorage();
    const store = localStorageTokenStore(storage);

    await store.set("plr_x");
    expect(storage.getItem(REFRESH_TOKEN_KEY)).toBe("plr_x");
    expect(await store.get()).toBe("plr_x");
    await store.clear();
    expect(await store.get()).toBeNull();
  });

  it("degrades quietly when storage throws", async () => {
    const broken = {
      getItem() {
        throw new Error("denied");
      },
      setItem() {
        throw new Error("denied");
      },
      removeItem() {
        throw new Error("denied");
      },
    } as unknown as Storage;
    const store = localStorageTokenStore(broken);

    await store.set("plr_x");
    expect(await store.get()).toBeNull();
    await store.clear();
  });
});
