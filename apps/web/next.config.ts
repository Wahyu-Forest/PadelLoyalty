import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Static HTML export: served by any static host and bundled into the
  // Capacitor iOS/Android apps. No Next.js server features; data comes from the API.
  output: "export",
  // Emit /admin/index.html etc., which static hosts and Capacitor resolve reliably.
  trailingSlash: true,
  images: { unoptimized: true },
  reactStrictMode: true,
};

export default nextConfig;
