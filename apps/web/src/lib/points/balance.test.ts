import type { PointsBalanceResponse } from "@padelloyalty/shared";
import { describe, expect, it, vi } from "vitest";
import type { ApiResult } from "../auth/api";
import { BalanceLoader, formatPoints, type BalanceState } from "./balance";

const ok = (balance: number): ApiResult<PointsBalanceResponse> => ({
  ok: true,
  data: { balance, asOf: "2026-11-24T10:00:00.000Z" },
});
const fail = (code: "network_error" | "unauthorized" = "network_error") =>
  ({ ok: false, error: { code, message: "Can't reach Soul Padel right now." } }) as const;

/** A fetch whose answers the test releases one by one. */
function controlledFetch() {
  const pending: ((result: ApiResult<PointsBalanceResponse> | null) => void)[] = [];
  const fetch = vi.fn(
    () => new Promise<ApiResult<PointsBalanceResponse> | null>((resolve) => pending.push(resolve)),
  );
  return {
    fetch,
    answer: (result: ApiResult<PointsBalanceResponse> | null) => pending.shift()!(result),
  };
}

describe("BalanceLoader", () => {
  it("starts loading, then shows the balance", async () => {
    const loader = new BalanceLoader(async () => ok(1250));
    const states: BalanceState["status"][] = [];
    loader.subscribe((s) => states.push(s.status));
    expect(loader.getState()).toEqual({ status: "loading" });
    await loader.load();
    expect(loader.getState()).toMatchObject({
      status: "loaded",
      balance: 1250,
      refreshing: false,
      refreshError: null,
    });
    expect(states).toEqual(["loading", "loaded"]);
  });

  it("shows zero as a balance, not as an error", async () => {
    const loader = new BalanceLoader(async () => ok(0));
    await loader.load();
    expect(loader.getState()).toMatchObject({ status: "loaded", balance: 0 });
  });

  it("shows an error when the first load fails, and recovers on retry", async () => {
    const results = [fail(), ok(40)];
    const onError = vi.fn();
    const loader = new BalanceLoader(async () => results.shift()!, onError);
    await loader.load();
    expect(loader.getState()).toMatchObject({ status: "error", error: { code: "network_error" } });
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: "network_error" }));
    await loader.load();
    expect(loader.getState()).toMatchObject({ status: "loaded", balance: 40 });
  });

  it("treats a thrown fetch as an error instead of loading forever", async () => {
    const loader = new BalanceLoader(async () => {
      throw new Error("boom");
    });
    await loader.load();
    expect(loader.getState()).toMatchObject({ status: "error" });
  });

  it("keeps the last balance on screen while refreshing and when a refresh fails", async () => {
    const { fetch, answer } = controlledFetch();
    const loader = new BalanceLoader(fetch);
    const first = loader.load();
    answer(ok(100));
    await first;

    const second = loader.load();
    expect(loader.getState()).toMatchObject({ status: "loaded", balance: 100, refreshing: true });
    answer(fail());
    await second;
    expect(loader.getState()).toMatchObject({
      status: "loaded",
      balance: 100,
      refreshing: false,
      refreshError: { code: "network_error" },
    });

    const third = loader.load();
    answer(ok(160));
    await third;
    expect(loader.getState()).toMatchObject({ balance: 160, refreshError: null });
  });

  it("refetches once more when asked during a request, so a change is never missed", async () => {
    const { fetch, answer } = controlledFetch();
    const loader = new BalanceLoader(fetch);
    const first = loader.load();
    // e.g. an earn happened while the first request was on its way: three
    // signals (focus, visibility, notifyPointsChanged) cost one extra request.
    void loader.load();
    void loader.load();
    void loader.load();
    expect(fetch).toHaveBeenCalledTimes(1);
    answer(ok(100)); // the stale answer, read before the earn
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    answer(ok(150));
    await first;
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(loader.getState()).toMatchObject({ balance: 150 });
  });

  it("ignores a null answer (logged out) and stops after stop()", async () => {
    const { fetch, answer } = controlledFetch();
    const loader = new BalanceLoader(fetch);
    const listener = vi.fn();
    loader.subscribe(listener);
    const first = loader.load();
    answer(ok(5));
    await first;
    const second = loader.load();
    answer(null);
    await second;
    expect(loader.getState()).toMatchObject({ balance: 5, refreshing: false });

    listener.mockClear();
    const third = loader.load();
    loader.stop();
    answer(ok(999));
    await third;
    expect(loader.getState()).not.toMatchObject({ balance: 999 });
  });
});

describe("formatPoints", () => {
  it("groups digits for the locale", () => {
    expect(formatPoints(0, "en-US")).toBe("0");
    expect(formatPoints(1250, "en-US")).toBe("1,250");
    expect(formatPoints(1250000, "de-DE")).toBe("1.250.000");
  });
});
