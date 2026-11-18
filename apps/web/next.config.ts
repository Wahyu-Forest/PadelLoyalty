import type { NextConfig } from "next";
import { resolveBasePath } from "./src/lib/base-path";

// Empty for Capacitor and local builds (served from the root); "/PadelLoyalty"
// for GitHub Pages. Next.js also prefixes the /_next assets with it.
const basePath = resolveBasePath(process.env.NEXT_PUBLIC_BASE_PATH);

const nextConfig: NextConfig = {
  // Static HTML export: served by any static host and bundled into the
  // Capacitor iOS/Android apps. No Next.js server features; data comes from the API.
  output: "export",
  // Emit /admin/index.html etc., which static hosts and Capacitor resolve reliably.
  trailingSlash: true,
  images: { unoptimized: true },
  reactStrictMode: true,
  ...(basePath ? { basePath } : {}),
};

export default nextConfig;
