import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.soulpadel.app",
  appName: "Soul Padel",
  // Next.js static export output (`pnpm build`).
  webDir: "out",
  server: {
    // Android serves the app from https://localhost (must be in the API's CORS_ORIGINS).
    androidScheme: "https",
  },
};

export default config;
