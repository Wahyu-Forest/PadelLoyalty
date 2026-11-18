import { describe, expect, it } from "vitest";
import capacitorConfig from "../capacitor.config";
import nextConfig from "../next.config";

// Capacitor bundles whatever is in `webDir`, so it must point at the folder
// `next build` writes the static export to (Next.js always uses `out/`).
describe("Capacitor wraps the static export", () => {
  it("builds the web app as a static export", () => {
    expect(nextConfig.output).toBe("export");
  });

  it("points Capacitor at the static export folder", () => {
    expect(capacitorConfig.webDir).toBe("out");
  });

  it("uses the Soul Padel app id", () => {
    expect(capacitorConfig.appId).toBe("com.soulpadel.app");
  });

  it("serves the Android app from https://localhost (an origin the API allows by default)", () => {
    expect(capacitorConfig.server?.androidScheme).toBe("https");
  });
});
