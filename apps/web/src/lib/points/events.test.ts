import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("points change events", () => {
  it("does nothing without a window (static render)", async () => {
    const { notifyPointsChanged, onPointsChanged } = await import("./events");
    const listener = vi.fn();
    const off = onPointsChanged(listener);
    notifyPointsChanged();
    off();
    expect(listener).not.toHaveBeenCalled();
  });

  it("tells listeners in this tab once, and stops after unsubscribe", async () => {
    vi.stubGlobal("window", new EventTarget());
    const { notifyPointsChanged, onPointsChanged } = await import("./events");
    const listener = vi.fn();
    const off = onPointsChanged(listener);
    notifyPointsChanged();
    // Give a broadcast (which this tab must ignore) time to arrive.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(listener).toHaveBeenCalledTimes(1);
    off();
    notifyPointsChanged();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("tells other tabs through BroadcastChannel", async () => {
    vi.stubGlobal("window", new EventTarget());
    const otherTab = await import("./events");
    vi.resetModules();
    const thisTab = await import("./events");
    const listener = vi.fn();
    const off = otherTab.onPointsChanged(listener);
    thisTab.notifyPointsChanged();
    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(2)); // window event + broadcast
    off();
  });
});
