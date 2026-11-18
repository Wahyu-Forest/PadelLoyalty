import { afterEach, describe, expect, it, vi } from "vitest";
import type { NextConfig } from "next";

// next.config.ts reads NEXT_PUBLIC_BASE_PATH when it is loaded, so load a
// fresh copy for each environment.
async function loadNextConfig(basePath: string | undefined): Promise<NextConfig> {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_BASE_PATH", basePath);
  return (await import("../next.config")).default;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("next.config base path", () => {
  it("serves from the root by default, as the Capacitor apps need", async () => {
    const config = await loadNextConfig(undefined);
    expect(config.basePath).toBeUndefined();
    expect(config.assetPrefix).toBeUndefined();
  });

  it("serves under NEXT_PUBLIC_BASE_PATH for the GitHub Pages build", async () => {
    const config = await loadNextConfig("/PadelLoyalty/");
    expect(config.basePath).toBe("/PadelLoyalty");
    expect(config.output).toBe("export");
    expect(config.trailingSlash).toBe(true);
  });
});
